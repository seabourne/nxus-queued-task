'use strict'

import {BaseModel} from 'nxus-storage'

/**
 * Queued Task model.
 * Used to track progress, completion of worker-queue tasks.
 *
 */
const QueuedTaskModel = BaseModel.extend(
  /** @lends TaskModel */
  {
    connection: 'default',
    identity: 'queued_task',
    attributes: {
      name: 'string',
      /** @type {float} value from 0 to 1 */
      progress: 'float',
      taskData: 'json',
      completed: {
        type: 'boolean',
        defaultsTo: false,
      },
      route: 'string'
    }
  })

export {QueuedTaskModel as default}
