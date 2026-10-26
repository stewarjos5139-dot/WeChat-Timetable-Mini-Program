// utils/cloud.js
/**
 * 课表云备份。
 *
 * 本地存储是唯一真相，云端只是保险箱 —— **上传自动、恢复手动**（入口在「我的」）。
 * 不做双向同步，所以没有冲突合并的问题。
 *
 * 云端这份同时是上课提醒的数据源（服务端读不到手机本地存储），
 * 所以每次启动、切回课表页、开启提醒前都会用 ensureBackup() 静默补传，
 * 保证服务端读到的是本地最新的课表。
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

/** 最近一次成功上传对应的本地 stamp。用来判断云端镜像是不是最新的 */
const KEY_BACKUP_STAMP = 'schedule_backup_stamp'

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

/** 最近一次成功上传对应的本地 stamp；没备份过是 0 */
function readBackupStamp() {
  return Number(wx.getStorageSync(KEY_BACKUP_STAMP)) || 0
}

function writeBackupStamp(stamp) {
  try {
    wx.setStorageSync(KEY_BACKUP_STAMP, Number(stamp) || 0)
  } catch (err) {
    // 存不下标记不影响主流程，下次会多重传一次而已
  }
}

/**
 * 把本地四样（学号 / 课表 / 学期设置 / 姓名）打包上传。
 * 学号当 _id，set 是覆盖式的 —— 有就整体替换，没有就新建，不会越堆越多。
 *
 * **没有学号就跳过**；**本地课表为空也跳过** —— 云端那份是「从云端恢复」用的，
 * 不能被清空后的本地状态盖掉。
 *
 * 不往外抛异常，返回 { ok, reason }；失败时不更新标记，下次自动重试。
 */
function backup() {
  if (!available()) return Promise.resolve({ ok: false, reason: 'no-backend' })

  const studentId = localId()
  if (!studentId) return Promise.resolve({ ok: false, reason: 'no-account' })

  const courses = store.getCourses()
  if (!courses.length) return Promise.resolve({ ok: false, reason: 'empty' })

  // 先记下上传前的 stamp：上传期间又改了课，标记就对不上，下次会再传一遍
  const stamp = store.getStamp()

  const payload = {
    studentId: studentId,
    courses: courses,
    term: store.getTerm(),
    profile: store.getProfile(),
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now()
  }

  return wx.cloud.database().collection(COLLECTION)
    .doc(studentId)
    .set({ data: payload })
    .then(function () {
      writeBackupStamp(stamp)
      console.log('[cloud] 备份成功 学号=' + studentId +
        ' 姓名=' + ((payload.profile && payload.profile.name) || '-') +
        ' 课程=' + courses.length + ' 门')
      return { ok: true, reason: '' }
    })
    .catch(function (err) {
      console.warn('[cloud] 备份失败 学号=' + studentId +
        ' 姓名=' + ((payload.profile && payload.profile.name) || '-') +
        '（下次自动重试）：' + ((err && err.errMsg) || err))
      return { ok: false, reason: 'error' }
    })
}

/** 云端镜像是不是落后于本地。空课表、没学号、没云环境都不需要补传 */
function needsBackup() {
  if (!available()) return false
  if (!localId()) return false
  if (!store.getCourses().length) return false
  return store.getStamp() !== readBackupStamp()
}

let pendingBackup = null

/**
 * 后台静默补传：已是最新就什么都不做；正在传就复用同一个 Promise。
 * 永远 resolve，调用方不用 catch，也不用给用户任何提示。
 */
function ensureBackup() {
  if (!available()) return Promise.resolve({ ok: false, reason: 'no-backend' })
  if (!localId()) return Promise.resolve({ ok: false, reason: 'no-account' })
  if (!store.getCourses().length) return Promise.resolve({ ok: false, reason: 'empty' })
  if (!needsBackup()) return Promise.resolve({ ok: true, reason: '' })
  if (pendingBackup) return pendingBackup

  pendingBackup = backup().then(function (res) {
    pendingBackup = null
    return res
  })
  return pendingBackup
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
      // 本地刚刚和云端对齐，标记为已同步，下次启动不会重复上传
      writeBackupStamp(store.getStamp())

      const name = (doc.profile && doc.profile.name) || '-'
      console.log('[cloud] 恢复成功 学号=' + id + ' 姓名=' + name + ' 课程=' + courses.length + ' 门')
      return { ok: true, count: parser.summarize(courses).courses, reason: '' }
    })
    .catch(function (err) {
      console.warn('[cloud] 恢复失败 学号=' + id + '：', err)
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
  ensureBackup: ensureBackup,
  needsBackup: needsBackup,
  restore: restore
}
