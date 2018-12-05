/* globals beforeAll: false, describe: false, it: false, expect: false */

import QueuedTask from '../'

let queuedTask

beforeAll(() => {
  queuedTask = new QueuedTask()
})

describe('Sanity', () => {
  it('has expected properties', async () => {
    expect(queuedTask).toHaveProperty('taskRequestRoute')
    expect(queuedTask).toHaveProperty('createTaskQueue')
    expect(queuedTask).toHaveProperty('createTask')
    expect(queuedTask).toHaveProperty('getTaskState')
    expect(queuedTask).toHaveProperty('updateTaskState')
  })
})

