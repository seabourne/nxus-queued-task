import QueuedTask from '../'

let queuedTask

beforeAll(() => {
  queuedTask = new QueuedTask()
  
})

describe('Sanity', () => {
  it('has expected properties', async () => {
    expect(queuedTask).toHaveProperty('taskRequestRoute')
    expect(queuedTask).toHaveProperty('createWorkerTask')
  })
})

