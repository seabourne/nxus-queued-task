import {NxusModule} from 'nxus-core'
import {router} from 'nxus-router'

import {queuedTask} from '../../../src'
import {workerQueue} from 'nxus-worker-queue'

export default class Tasks extends NxusModule {
  constructor() {
    super()

    workerQueue.worker('test-task', (job) => {
      return {success: true}
    })
    
    queuedTask.taskRequestRoute('/task', async (req, res) => {
      return await queuedTask.createWorkerTask({name: 'test-task', taskData: req.body})
    })
  }
  
}
