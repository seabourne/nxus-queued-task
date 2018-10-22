let queuedTask = application.get('queued-task')

let url = '/task'

async function createUser (email, password = 'test', admin=false) {
  let User = await storage.getModel('users-user')
  return User.findOrCreate({email}, {email, password, admin, enabled: true})
}

async function requestLogin (email, password = 'test', request = tester.request) {
  var jar = request.jar()
  var req = request.defaults({jar: jar})
  req.cookieJar = jar
  await req.post({
    url: 'login',
    form: {
      username: email,
      password: password
    },
    simple: false,
    followRedirect: false
  })
  return req
}


let req, taskID
describe('Integration', () => {
  beforeAll(async () => {
    let email = 'test@example.com'
    let user = await createUser(email)
    req = await requestLogin(email)
    req = req.defaults({resolveWithFullResponse: true, simple: false})
  })
  it('Route responds to initial request by creating task', async () => {
    let res = await req.post({url, json: true}).form({count: 1})
    expect(res.statusCode).toEqual(200)
    expect(res.body).toHaveProperty('task.id')
    taskID = res.body.task.id
    expect(res.body).toHaveProperty('task.timestamp')
    expect(res.body).toHaveProperty('task.progress', 0)
    expect(res.body).toHaveProperty('task.completed', false)
  })
  it('QueuedTask record is updated on immediate completion', async () => {
    let t = await queuedTask.getTask(taskID)
    expect(t.taskData).toHaveProperty('count', "1")
    expect(t.taskData).toHaveProperty('success', true)
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
