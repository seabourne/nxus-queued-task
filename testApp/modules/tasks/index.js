import {NxusModule} from 'nxus-core'

import {queuedTask} from '../../../src'

const increment = 1 * 1000

function delay(mills) {
  return new Promise((resolve, reject) => { setTimeout(resolve, mills, undefined) })
}

export default class Tasks extends NxusModule {
  constructor() {
    super()

    queuedTask.createTaskQueue('test-task', async (state) => {
this.log.info('task')
      return {taskResults: {success: true, count: state.taskData.count}}
    })
    queuedTask.taskRequestRoute('/task', 'test-task')

    queuedTask.createTaskQueue('test-incremental-task', async (state) => {
      for (let i = 1; i < 10; i += 1) {
        await delay(increment)
        state = await queuedTask.updateTaskState(state.id, i / 10)
      }
      await delay(increment)
      return {taskResults: {success: true}}
    })
    queuedTask.taskRequestRoute('/incremental-task', 'test-incremental-task')

  }

}
