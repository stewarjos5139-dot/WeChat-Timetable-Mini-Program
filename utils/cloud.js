// utils/cloud.js
/**
 * 课表云备份。
 *
 * 本地存储是唯一真相，云端只是保险箱 —— **上传自动、恢复手动**（入口在「我的」）。
 * 不做双向同步，所以没有冲突合并的问题。
 *
 * 所有函数都**不往外抛异常**：云上出问题不能让小程序本身不能用。
 *
 * 一条记录的 **_id 就是学号** —— 一个学号一条，物理上不可能重复；
 * 写入走 set（覆盖式），连着触发两次也不会多出一条。
 * 集合权限仍是「仅创建者可读写」，所以查询只会命中自己那条，
 * 别人就算知道学号也读不到。
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

/** 本机存的学号。没导入过课表就是空串 */
function localId() {
  const profile = store.getProfile()
  return String((profile && profile.studentId) || '').trim()
}

/**
 * 按学号取那条文档。
 *
 * 用 where({_id}) 而不是 doc(id).get()：后者在文档不存在时是**报错**，
 * 得去猜错误码才知道是「没备份」还是「网络挂了」；where 查不到就是空数组，
 * 两种情况天然分得开。
 *
 * 查询别人的文档会被权限挡掉，同样落到空数组 —— 从我的角度那就是「没备份」。
 */
function findDoc(studentId) {
  return wx.cloud.database().collection(COLLECTION)
    .where({ _id: studentId })
    .limit(1)
    .get()
    .then(function (res) {
      return (res.data && res.data[0]) || null
    })
}

/**
 * 把本地四样（学号 / 课表 / 学期设置 / 姓名）打包上传。
 * 学号当 _id，set 是覆盖式的 —— 有就整体替换，没有就新建，不会越堆越多。
 *
 * **没有学号就跳过**：不知道往哪条上写。没导入过课表的话本来也没什么可备份的。
 *
 * 失败**静默** —— 用户没主动要求备份，不该被弹窗打断，下次数据变化再补上。
 */
function backup() {
  if (!available()) return Promise.resolve()

  const studentId = localId()
  if (!studentId) return Promise.resolve()

  const payload = {
    studentId: studentId,
    courses: store.getCourses(),
    term: store.getTerm(),
    profile: store.getProfile(),
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now()
  }

  return wx.cloud.database().collection(COLLECTION)
    .doc(studentId)
    .set({ data: payload })
    .catch(function (err) {
      console.warn('[cloud] 备份失败（已忽略）:', (err && err.errMsg) || err)
    })
}

/**
 * 从云端写回本地。
 *
 * @param {string} [studentId] 要恢复哪个学号的备份。不传就用本机存的。
 *   目前调用方一律不传 —— 「重装后手动输学号」的入口还没做，之后单独设计。
 *   参数位先留着，到时候只用改「我的」那一层。
 *
 * @returns {Promise<{ok: boolean, count: number, reason: string, message?: string}>}
 *   reason 取值：
 *     ''           成功
 *     'no-backend' 没配云环境
 *     'no-account' 不知道该找哪个学号（本机没有，调用方也没给）
 *     'no-backup'  云端没有这个学号的备份（或备份是空的）
 *     'schema'     备份版本不认
 *     'error'      网络 / 其他错误，message 里有原因
 */
function restore(studentId) {
  if (!available()) {
    return Promise.resolve({ ok: false, count: 0, reason: 'no-backend' })
  }

  const id = String(studentId || '').trim() || localId()
  if (!id) {
    return Promise.resolve({ ok: false, count: 0, reason: 'no-account' })
  }

  return findDoc(id)
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
