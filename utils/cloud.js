// utils/cloud.js
/**
 * 课表云备份。
 *
 * 本地存储是唯一真相，云端只是保险箱 —— **上传自动、恢复手动**（入口在「我的」）。
 * 不做双向同步，所以没有冲突合并的问题。
 *
 * 所有函数都**不往外抛异常**：云上出问题不能让小程序本身不能用。
 *
 * 依赖云开发数据库，集合名见 COLLECTION —— 需要在云开发控制台手工建，
 * 权限必须选「仅创建者可读写」。
 */

const config = require('./config')
const store = require('./store')
const parser = require('./parser')

/** 云数据库集合名。要手工新建，权限选「仅创建者可读写」 */
const COLLECTION = 'schedules'

/** 数据结构版本。以后改字段时加一，restore 里判断不认就跳过、不硬塞 */
const SCHEMA_VERSION = 1

/** 云环境没配（或基础库太老没有云能力）时，所有操作都当成「没有云」直接跳过 */
function available() {
  return !!(config.CLOUD_ENV && wx.cloud && wx.cloud.database)
}

/**
 * 取当前用户那条文档。默认权限下 .get() 只会返回自己的数据。
 * limit(1) 是为了避开客户端默认 20 条的限制。
 */
function findDoc() {
  return wx.cloud.database().collection(COLLECTION).limit(1).get()
    .then(function (res) {
      return (res.data && res.data[0]) || null
    })
}

/**
 * 把本地三样（课表 / 学期设置 / 姓名学号）打包上传。
 * 有文档就更新，没有就新建。
 *
 * 失败**静默** —— 用户没主动要求备份，不该被弹窗打断，下次数据变化再补上。
 */
function backup() {
  if (!available()) return Promise.resolve()

  const payload = {
    courses: store.getCourses(),
    term: store.getTerm(),
    profile: store.getProfile(),
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now()
  }

  const db = wx.cloud.database()

  return findDoc()
    .then(function (doc) {
      if (doc) return db.collection(COLLECTION).doc(doc._id).update({ data: payload })
      return db.collection(COLLECTION).add({ data: payload })
    })
    .catch(function (err) {
      console.warn('[cloud] 备份失败（已忽略）:', (err && err.errMsg) || err)
    })
}

/**
 * 从云端写回本地。
 *
 * @returns {Promise<{ok: boolean, count: number, reason: string, message?: string}>}
 *   reason 取值：
 *     ''          成功
 *     'no-backend' 没配云环境
 *     'no-backup' 云端没有备份（或备份是空的）
 *     'schema'    备份版本不认
 *     'error'     网络 / 其他错误，message 里有原因
 */
function restore() {
  if (!available()) {
    return Promise.resolve({ ok: false, count: 0, reason: 'no-backend' })
  }

  return findDoc()
    .then(function (doc) {
      if (!doc) return { ok: false, count: 0, reason: 'no-backup' }
      if (doc.schemaVersion !== SCHEMA_VERSION) return { ok: false, count: 0, reason: 'schema' }

      const courses = Array.isArray(doc.courses) ? doc.courses : []
      if (!courses.length) return { ok: false, count: 0, reason: 'no-backup' }

      // 必须走 store 的写入函数 —— 它们会顺带刷新 schedule_stamp，
      // 课表页靠那个判断要不要重建。自己碰 storage 的话页面不会刷新。
      store.setCourses(courses)
      if (doc.term) store.setTerm(doc.term)
      if (doc.profile && doc.profile.studentId) store.setProfile(doc.profile)

      return { ok: true, count: parser.summarize(courses).courses, reason: '' }
    })
    .catch(function (err) {
      console.warn('[cloud] 恢复失败:', err)
      return {
        ok: false,
        count: 0,
        reason: 'error',
        message: (err && err.errMsg) || String(err)
      }
    })
}

module.exports = {
  available: available,
  backup: backup,
  restore: restore
}
