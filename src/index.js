'use strict'

import {HasModels} from 'nxus-storage'
import {router} from 'nxus-router'
import {users} from 'nxus-users'
import {workerQueue} from 'nxus-worker-queue'

const taskProgressLimit = 20 * 1000

const defaultTaskProperties = {
  name: '',
  progress: 0.0,
  taskData: undefined }
const initialTaskProperties = ['name', 'progress', 'taskData']
const responseTaskProperties = ['id', 'progress', 'taskData', 'completed', 'timestamp']

function pick(obj, props) {
  let picked = {}
  for (let key of props)
    if (obj[key] !== undefined) picked[key] = obj[key]
  return picked
}


/** Queued Tasks.
 *
 * The `completed` state of a task depends on its `progress`. A task is
 * completed when its progress value is 1.0 (or greater).
 *
 */
class QueuedTask extends HasModels {

  constructor() {
    super({
      modelNames: {
        'queued_task': 'QueuedTask' }
    })
  }

  /** Creates a queued task.
   * @param {string|Object} properties initial properties; may be either
   *   a `name` string or an object containing `name`, `progress` and
   *   `taskData` properties.
   * @return {Object} created queued task entity
   */
  async createTask(properties) {
    if (typeof properties === 'string') properties = {name: properties}
    properties = Object.assign({}, defaultTaskProperties, pick(properties, initialTaskProperties))
    properties.completed = properties.progress >= 1.0
    let rslt = await this.models.QueuedTask.create(properties)
    return rslt
  }

  /** Creates a queued task backed by a worker queue task.
   * It creates the queued task, then starts a worker queue task using
   * the queued task name, passing it the queued task entity. When the
   * worker task completes, the queued task is marked as completed.
   * If the worker task is successful, the `taskData` is updated with
   * its results; if it fails, its error status is added as a
   * `taskData.error` property.
   *
   * Since the worker queue task has access to the queued task entity,
   * it can update the task `progress` state or `taskData` properties.
   *
   * @param {string|Object} properties initial properties; may be either
   *   a `name` string or an object containing `name`, `progress` and
   *   `taskData` properties.
   * @return {Object} created queued task entity
   */
  async createWorkerTask(properties) {
    let task = await this.createTask(properties),
        job = await workerQueue.task(task.name, task)
    job.finished().then(
      (rslt) => {
        return this.updateTask(task.id, {progress: 1.0, taskData: rslt})
      },
      (err) => {
        let msg = err.message
        return this.updateTask(task.id, {progress: 1.0, taskData: {msg}})
      }
    )
    return task
  }

  /** Updates a queued task.
   * @param {string} id id of queued task
   * @param {float|Object} properties properties to update; may be
   *   either a `progress` float or an object containing `progress` and
   *   `taskData` properties (which update the existing `taskData`
   *   properties)
   * @return {Object} updated queued task entity
   */
  async updateTask(id, properties) {
    if (typeof properties === 'number') properties = {progress: properties}
    if (properties.progress !== undefined) properties.completed = properties.progress >= 1.0
    if (properties.taskData) {
      let task = await this.getTask(id)
      properties.taskData = Object.assign(task.taskData, properties.taskData)
    }
    let rslt = await this.models.QueuedTask.update({id}, properties).then(rslts => rslts[0])
    queuedTask.emit('queued-task-progress', rslt)
    return rslt
  }

  /** Gets queued task entity.
   * @param {string} id id of queued task
   * @return {Object} queued task entity
   */
  getTask(id) {
    return this.models.QueuedTask.findOne(id)
  }

  /** Finds queued task entities.
   * @param {Object} query query object
   * @return {Array} queued task entities
   */
  findTasks(query) {
    return this.models.QueuedTask.find(query)
  }

  /** Creates request route for the queued task.
   *
   * *   POST _`route`_`
   *
   * @param {string} route URL for the route
   * @param {string|Function} task worker task name or task method;
   *   if passed a task name string, uses `createWorkerTask()` to
   *   initiate the task, passing it the task name and any initial
   *   `taskData` specified in the request body; if passed a function,
   *   it invokes it to initiate the task, passing it the request,
   *   expecting a task entity to be returned
   */
  async taskRequestRoute(route, task) {
    let initiate = (task instanceof Function) ?
          task :
          (req) => {
            let params = {name: task, taskData: req.body.taskData || {}}
            return this.createWorkerTask(params)
          }
    users.protectedRoute(route)
    await router.route('post', route, this._requestHandler.bind(this, route, initiate))
  }

  /* Queued task request handler.
   *
   * Uses absence of `id` property to indicate initial invocation.
   * Initiates request on initial invocation; polls for task status on
   * subsequent invocations.
   *
   * When polled for task status, the response body is a JSON object
   * containing a `task` object with `progress`, `taskData`,
   * `completed` and `timestamp` properties.
   *
   * Intended for use with <monitored-data-request>.
   */
  async _requestHandler(route, initiate, req, res) {
    let taskId = req.body.id,
        promise

    function isChanged(task, timestamp) { return (!task || task.completed || (task.timestamp > timestamp)) }

    if (!taskId) { // initial request
      let task
      try {
        task = await initiate(req)
        task.route = route
        await task.save()
      }
      catch (e) {
        this.log.error('queued-task _requestHandler ', e)
      }
      promise = Promise.resolve(this._packageTask(task))
    }
    else {
      let task = await this.getTask(taskId)
      if (route !== task.route) {
        this.log.error('queued-task _requestHandler route mismatch')
        promise = Promise.resolve()
        res.status(400)
      }
      else {
        let timestamp = req.body.timestamp || 0
        task = this._packageTask(task)
        if (isChanged(task, timestamp))
          promise = Promise.resolve(task)
        else {
          let timerId,
              progressListener,
              timer = new Promise((resolve, reject) => {
                timerId = setTimeout(() => {
                  resolve(task)
                  timerId = undefined
                }, taskProgressLimit)
              }),
              checker = new Promise((resolve, reject) => {
                progressListener = (task) => {
                  if (task.id === taskId) {
                    task = this._packageTask(task)
                    if (isChanged(task, timestamp)) resolve(task)
                  }
                }
                queuedTask.on('queued-task-progress', progressListener)
              })
          promise = Promise.race([checker, timer])
            .finally(() => {
              if (timerId) clearTimeout(timerId)
              queuedTask.removeListener('queued-task-progress', progressListener)
            })
        }
      }
    }

    return promise.then((task) => {
      res.json({task})
    })
  }

  _packageTask(task) {
    if (!task)
      task = {progress: 1.0, completed: true}
    else {
      let timestamp = task.updatedAt.valueOf()
      task = pick(task, responseTaskProperties)
      task.timestamp = timestamp
    }
    return task
  }

}

let queuedTask = QueuedTask.getProxy()

export {QueuedTask as default, queuedTask}
