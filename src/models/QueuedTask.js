'use strict'

import {BaseModel} from 'nxus-storage'

/**
 * Queued Task model
 * used to track progress, completion of worker-queue tasks.
 *
 */
const QueuedTaskModel = BaseModel.extend(
  /** @lends TaskModel */
  {
    connection: 'default',
    identity: 'queued_task',
    attributes: {
      name: 'string',
      jobId: 'string',
      /** @type {float} value from 0 to 1 */
      progress: 'float',
      completed: {
        type: 'boolean',
        defaultsTo: false,
      },
      taskData: 'json',
      taskResults: 'json',
      lifespan: 'float',
      route: 'string',
      expiresAt: 'datetime'
    }
  })

export {QueuedTaskModel as default}
