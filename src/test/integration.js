/* globals application: false, storage: false, tester: false,
    jest: false, beforeAll: false, describe: false, it: false, expect: false */

let queuedTask = application.get('queued-task')

let url = '/task'
let incrementalUrl = '/incremental-task'

async function createUser(email, password = 'test', admin=false) {
  let User = await storage.getModel('users-user')
  return User.findOrCreate({email}, {email, password, admin, enabled: true})
}

describe('Integration', () => {
  let req, taskID
  beforeAll(async () => {
    let email = 'test@example.com'
    let user = await createUser(email)
    req = await tester.requestLogin(email)
    req = req.defaults({resolveWithFullResponse: true, simple: false})
  })
  it('Route responds to initial request by creating task', async () => {
    let res = await req.post({url, json: true}).form({count: 1})
    expect(res.statusCode).toEqual(200)
    expect(res.body).toHaveProperty('task.id')
    taskID = res.body.task.id
    expect(res.body).toHaveProperty('task.timestamp')
    expect(res.body).toHaveProperty('task.progress') // may be 0 or 1
    expect(res.body).toHaveProperty('task.completed') // may be true or false
  })
  it('QueuedTask record is updated on immediate completion', async () => {
    let t = await queuedTask.getTaskState(taskID)
    expect(t).toHaveProperty('taskData')
    expect(t).toHaveProperty('taskResults')
    expect(t.taskResults).toHaveProperty('count', "1")
    expect(t.taskResults).toHaveProperty('success', true)
  })
  it('Route responds to subsequent request', async () => {
    let res = await req.post({url, json: true}).form({id: taskID})
    expect(res.statusCode).toEqual(200)
    expect(res.body).toHaveProperty('task.id', taskID)
    expect(res.body).toHaveProperty('task.timestamp')
    expect(res.body).toHaveProperty('task.progress', 1)
    expect(res.body).toHaveProperty('task.completed', true)
  })
})

describe('Integration, status queries', () => {
  let req, taskID, taskTimestamp
  beforeAll(async () => {
    jest.setTimeout(5000 + 10 * 2 * 1000)
    let email = 'test@example.com'
    let user = await createUser(email)
    req = await tester.requestLogin(email)
    req = req.defaults({resolveWithFullResponse: true, simple: false})
  })
  it('Route responds to initial request by creating incremental task', async () => {
    let res = await req.post({url: incrementalUrl, json: true}).form({count: 1})
    expect(res.statusCode).toEqual(200)
    expect(res.body).toHaveProperty('task.id')
    taskID = res.body.task.id
    expect(res.body).toHaveProperty('task.timestamp')
    taskTimestamp = res.body.task.timestamp
    expect(res.body).toHaveProperty('task.progress', 0)
    expect(res.body).toHaveProperty('task.completed', false)
  })
  it('Route responds to subsequent requests', async () => {
    let next = 1
    for (;;) {
      let res = await req.post({url: incrementalUrl, json: true}).form({id: taskID, timestamp: taskTimestamp})
      expect(res.statusCode).toEqual(200)
      expect(res.body).toHaveProperty('task.id', taskID)
      expect(res.body).toHaveProperty('task.timestamp')
      taskTimestamp = res.body.task.timestamp
      expect(res.body).toHaveProperty('task.progress', next / 10)
      expect(res.body).toHaveProperty('task.completed', next == 10)
      if (res.body.task.completed) break
      next = Math.round(res.body.task.progress * 10) + 1
    }
  })
})
