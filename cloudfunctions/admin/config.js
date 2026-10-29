/**
 * 管理云函数的配置。
 *
 * **改完要重新上传云函数才生效。**
 */

module.exports = {
  /**
   * 允许进入后台的 openid。
   * 前端不做任何判断，每一个 action 都在 index.js 里比这张表。
   * 换人只改这里，然后重新部署。
   */
  ADMIN_OPENIDS: [
    'oHAAGxuuVqHpnlbnwrKNkJ4bXDM4'
  ],

  COLLECTIONS: {
    schedules: 'schedules',
    reminders: 'reminders',
    logs: 'reminder_logs',
    notices: 'notices'
  },

  /** 公告固定用这一条文档，不新增、不累积 */
  NOTICE_ID: 'current',

  /**
   * 单次请求最多读多少条。后台是给自己用的，
   * 这个量级下「全读回来在内存里排」比在数据库里拼索引简单也更稳。
   */
  MAX_USERS: 2000,
  MAX_LOGS: 300
}
