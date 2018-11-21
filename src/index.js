'use strict'

import {pick} from 'lodash'

import {application} from 'nxus-core'
import {HasModels} from 'nxus-storage'
import {router} from 'nxus-router'
import {users} from 'nxus-users'
import {workerQueue} from 'nxus-worker-queue'

// max delay for response to task request or status query
//   chosen to stay comfortably within 30 sec Heroku request timeout limit
const taskProgressLimit = 20 * 1000

const defaultTaskProperties = {
  name: '',
  jobId: '',
  progress: 0.0,
  completed: false,
  taskData: undefined,
  taskResults: undefined,
  lifespan: 24 * 60 * 60 * 1000,
  route: undefined }
const initialTaskProperties = {
  progress: 0.0,
  completed: false }
const finalTaskProperties = {
  progress: 1.0,
  completed: true }
const taskStateProperties = ['id', 'name', 'jobId', 'progress', 'completed', 'timestamp', 'lifespan', 'route', 'taskData', 'taskResults']
const jobDataProperties = ['id']
const responseTaskProperties = ['id', 'progress', 'taskResults', 'completed', 'timestamp']


/** Queued Tasks.
 *
 * Wrapper around nxus-worker-queue to provide more structured handling
 * of queued tasks.
 *
 * For synchronization with worker queue tasks, it allows tasks to
 * update the queued task state and progress, and it provides
 * notification events for task progress and completion.
 *
 * For handling client requests, it provides routing and a polling
 * protocol for monitorinng task progress.
 *
 * ### Task state object
 *
 * The state of a queued task is described by an object with these
 * properties:
 * *   `id` - string, task id
 * *   `name` - string, worker queue task name
 * *   `jobId` - string, worker queue job id
 * *   `progress` - number in the range `[0..1]`, indicates progress of
 *       the task towards completion; a task is completed when its
 *       progress reaches one.
 * *   `completed` - boolean, true when task is completed
 * *   `timestamp` - number, modification timestamp
 * *   `taskData` - object containing input data for the task; may be
 *       updated with intermediate results
 * *   `taskResults` - results data for the task; may be updated with
 *       intermediate results
 * *   `lifespan` - number of milliseconds, the minimum amount of time
 *       task data should be preserved after task completion
 * *   `route` - string (internal use), route URL
 *
 * The `getTaskState()` method is used to retrieve the task state for a
 * queued task, and `updateTaskState()` to update it.
 *
 * See `taskRequestRoute()` for additional detail on how the task state
 * object is used to transfer task data between client and server.
 * Essentially, `taskData` holds data from the client, or
 * server-generated data that won't be shared directly with the client,
 * and `taskResults` holds results data that will be shared.
 *
 * ### Events
 *
 * *   `queued-task-progress` - emitted when the progress of a queued
 *       task changes, with the task state object as argument; it will
 *       always be emitted when the task completes, and will be emitted
 *       for any intermediate changes to the task progress
 *
 *       Note that `queued-task-progress` events will continue to be
 *       emitted for a task that has been restarted (due to an
 *       application restart, for example). For long-running tasks,
 *       this may provide more reliable synchronization than relying
 *       on the `job.finished()` promise.
 *
 * ### Persistent storage of task information
 *
 * The nxus-worker-queue module uses a Redis database for managing the
 * worker task queues and synchronizing between worker and web
 * processes. In particular, the Redis entry for a task records task
 * progress and completion.
 *
 * The Redis database, however, is typically configured with limited
 * storage capacity, so it's not a good choice for storing task data.
 * Instead, we pair the Redis entry with a `QueuedTask` model to hold
 * the task data, and use the Redis entry solely for coordination with
 * the worker task queue. The Redis entry `data.id` property and the
 * `QueuedTask` `jobId` property link the two together.
 *
 * MongoDB has a 16 megabyte size limit on BSON documents.
 *
 * ### To Do
 *
 * *   The code below would benefit from having direct access to the
 *     nxus-worker-queue task queues. As it is, we grab the queue
 *     information when jobs are created, but this information will be
 *     lost across a process restart. In fact, there seems to be a
 *     more general problem in establishing queue event handlers in the
 *     web process, independent of job creation.
 *
 */
class QueuedTask extends HasModels {

  constructor() {
    super({
      modelNames: {
        'queued_task': 'QueuedTask' }
    })
    this._queues = {}
    application.once('launch', async () => {
      let rslts = await this.models.QueuedTask.destroy({expiresAt: {'<': new Date()}})
      if (rslts.length > 0)
        this.log.debug(`deleted ${rslts.length} expired queued tasks`)
    })
  }

  /** Creates a task queue.
   * This is a simple wrapper around a nxus-worker-queue task handler
   * that adapts it to use task state objects.
   *
   * @param {string} name - name of the task queue
   * @param {Function} handler - handler for processing task requests;
   *   passed a task state object; should return a promise that resolves
   *   on completion to an object containing task state properties
   *   (suitable for input to `updateTaskStatus()`)
   * @param {Object} options - queue options (passed to the Bull
   *   `Queue` constructor)
   */
  createTaskQueue(name, handler, options = {}) {
    workerQueue.worker(name,
      async (job) => {
        this._setupQueue(name, job.queue)
        let state = await this.getTaskState(job.data.id)
        state = await handler(state)
          .catch((err) => {
            return {taskResults: {msg: err.message, severity: 'error'}}
          })
          .then((rslt) => {
            let properties = Object.assign({}, rslt, finalTaskProperties)
            return this.updateTaskState(state.id, properties)
          })
        return state
      },
      options)
  }

  /** Creates a queued task.
   * It assembles a task state object for the task, then starts a task,
   * passing it the task state object.
   *
   * When the worker queue task completes, the queued task is marked as
   * completed. If successful, the task `taskResults` are updated with
   * the results from the worker queue task; if there is an error, the
   * error status is added as a `taskResults.msg` property.
   *
   * @param {string|Object} properties initial task state properties;
   *   may be either a task queue `name` string or an object containing
   *   `name`, `progress` and `taskData` properties.
   * @return {Object} task state object for created queued task
   */
  async createTask(properties) {
    // assemble task properties
    let data = Object.assign({}, defaultTaskProperties,
          (typeof properties === 'string') ? {name: properties} : properties,
          initialTaskProperties),
        state = this._adjustTaskState(await this.models.QueuedTask.create(data))
    // start worker task, save reference to task queue if not already recorded
    //   (updateTaskState will set the expiresAt property)
    let job = await workerQueue.task(state.name, pick(state, jobDataProperties))
    state = await this.updateTaskState(state.id, {jobId: job.id})
    this._setupQueue(state.name, job.queue, true)
    return state
  }

  /** Gets the task state object.
   * @param {Object} id - task id
   * @return {Object} task state object; undefined if no match for id
   */
  async getTaskState(id) {
    let rslt = await this.models.QueuedTask.findOne(id)
    return rslt && this._adjustTaskState(rslt)
  }

  /** Updates the task state for a queued task.
   * May be invoked from a worker queue task to record progress or
   * intermediate results.
   *
   * @param {string} id - task id
   * @param {float|Object} properties - properties to update; may be
   *   either a `progress` float or an object containing `progress`,
   *   `taskData` and `taskResults` properties (non-null `taskData` or
   *   `taskResults` properties are merged into the existing properties)
   * @return {Object} updated task state object
   */
  async updateTaskState(id, properties) {
    // assemble task state update properties
    //   (do merge of `taskData` and `taskResults`)
    let data = (typeof properties === 'number') ? {progress: properties} : Object.assign({}, properties),
        state = await this.getTaskState(id)
    if (data.taskData || data.taskResults) {
      if (data.taskData && state.taskData)
        data.taskData = Object.assign(state.taskData, data.taskData)
      if (data.taskResults && state.taskResults)
        data.taskResults = Object.assign(state.taskResults, data.taskResults)
    }
    if (data.progress !== undefined) data.completed = data.progress >= 1.0
    data.expiresAt = new Date(Date.now() + state.lifespan)
    // update task state object and job progress
    state = await this._updateTaskState(id, data)
    if (data.progress) {
      let spec = this._queues[state.name]
      if (!spec)
        this.log.debug(`missing definition for queue ${state.name}`)
      else {
        let job = await spec.queue.getJob(state.jobId)
        let progress = data.progress * 100
        if (progress != job._progress) await job.progress(progress)
      }
    }
    return state
  }


  /** Creates request route for the queued task.
   * The route can be used to initiate a request and to poll its status.
   *
   * *   POST _`route`_`
   *
   * A single route is used for both request initiation and status
   * polling. The handler uses the absence of an `id` property in the
   * request to indicate the initial invocation. Subsequent invocations
   * (with `id` property) are treated as polling for task status.
   *
   * The response body is a JSON object containing a `task` object with
   * `id`, `progress`, `taskResults`, `completed` and `timestamp`
   * properties.
   *
   * A polling request should specify the task `id` and the `timestamp`
   * property from the most recent response. The handler compares the
   * timestamp with the current task state timestamp to determine
   * whether the state has changed since last reported. The handler
   * delays a response until there is a change in state (although it
   * will respond with unchanged state information to avoid a request
   * timeout).
   *
   * Intended for use with <monitored-data-request>.
   *
   * @param {string} route - URL for the route
   * @param {string} taskName - worker task name
   * @param {Function} initiate - task initiation method, passed the
   *   request and expected to return a promise that resolves to a task
   *   state object; if omitted, the task is created with
   *   `createTask()`, using the task name, and initializing `taskData`
   *   to the contents of the request body
   */
  async taskRequestRoute(route, taskName, initiate) {
    if (!initiate)
      initiate = (req) => {
        let params = {name: taskName, taskData: req.body || {}}
        return this.createTask(params)
      }
    users.protectedRoute(route)
    await router.route('post', route, this._requestHandler.bind(this, route, taskName, initiate))
  }

  async _requestHandler(route, taskName, initiate, req, res) {
    let taskId = req.body.id,
        promise

    function isChanged(state, timestamp) { return (!state || state.completed || (state.timestamp > timestamp)) }

    if (!taskId) { // initial request
      let state
      try {
        state = await initiate(req)
        state = await this._updateTaskState(state.id, {route})
      }
      catch (e) {
        this.log.error('queued-task _requestHandler ', e)
      }
      promise = Promise.resolve(state)
    }
    else { // status poll
      let state = await this.getTaskState(taskId)
      if (route !== state.route) {
        this.log.error('queued-task _requestHandler route mismatch')
        promise = Promise.resolve()
        res.status(400)
      }
      else {
        let timestamp = req.body.timestamp || 0
        if (isChanged(state, timestamp))
          promise = Promise.resolve(state)
        else {
          let timerId,
              progressListener,
              timer = new Promise((resolve, reject) => {
                timerId = setTimeout(() => {
                  resolve(state)
                  timerId = undefined
                }, taskProgressLimit)
              }),
              checker = new Promise((resolve, reject) => {
                progressListener = (state) => {
                  if (state.id === taskId)
                    if (isChanged(state, timestamp)) resolve(state)
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

    return promise.then((state) => {
      state = state ?
        pick(state, responseTaskProperties) :
        {progress: 1.0, completed: true}
      res.json({task: state})
    })
  }


  /** Hack to gain access to Bull queues.
   * We need access to the queue `getJob()` method, and to listen for
   * progress events. The only access we have is through the job object,
   * which is available when the job is created (in the web process) and
   * when it is executed (in the worker process).
   *
   * In addition to being ugly, this is only a partial solution, since
   * the queue context will be lost across a restart. An update to
   * `nxus-worker-queue` to provide access to the queues would be a
   * nicer solution.
   *
   * @private
   * @param {string} taskName - worker task name
   * @param {Object} queue - Bull queue object
   * @param {boolean} notify - if true, set up listener to forward queue
   *   `progress` events as `queued-task-progress` events
   */
  _setupQueue(taskName, queue, notify) {
    let spec = this._queues[taskName] || (this._queues[taskName] = {queue})
    if (notify && !spec.listener) {
      spec.listener = async (jobId, progress) => {
        let job = await spec.queue.getJob(jobId)
        if (job.data.id) {
          let state = await this.getTaskState(job.data.id)
          if (state) queuedTask.emit('queued-task-progress', state)
        }
      }
      spec.queue.on('global:progress', spec.listener)
    }
  }

  async _updateTaskState(id, properties) {
    let rslt = await this.models.QueuedTask.update({id}, properties).then(rslts => rslts[0])
    return this._adjustTaskState(rslt)
  }

  _adjustTaskState(entity) {
    let state = pick(entity, taskStateProperties)
    state.timestamp = entity.updatedAt.valueOf()
    return state
  }

}

let queuedTask = QueuedTask.getProxy()

export {QueuedTask as default, queuedTask}
