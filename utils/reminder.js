// utils/reminder.js
/**
 * 上课提醒的客户端封装。
 *
 * 两件事：
 *   1. 攒订阅额度 —— wx.requestSubscribeMessage **必须在点击回调里同步调用**，
 *      所以 enable() / renew() 要在 tap 事件里直接调，不能先 await 别的请求。
 *   2. 调云函数记录开关和额度，并把状态缓存在本地给页面秒开。
 *
 * 服务端见 cloudfunctions/reminder。
 */

const config = require('./config')
const cloud = require('./cloud')
const store = require('./store')

const CACHE_KEY = 'reminder_status'
/**
 * 一次点击最多能换多少条额度。
 * 微信规定 requestSubscribeMessage 只能在点击手势里调用，一次授权 = 一条消息；
 * 从 success 回调里连续调第 2 次起就不再是点击上下文，真机会直接失败。
 * 想多攒只能让用户多点几次（勾选「总是保持以上选择」后每次点击都不弹窗）。
 */
const MAX_PER_TAP = 1
/** 剩余多少条时开始提示续订 */
const LOW_QUOTA = 3
/** 状态缓存多久后重新向云端确认 */
const REFRESH_MS = 5 * 60 * 1000
/** 可选的课前提醒分钟数，必须与服务端 config.js 的 ALLOWED_LEAD_MINUTES 一致 */
const LEAD_OPTIONS = [5, 10, 15, 20, 30, 45, 60]
/** 用户没设置过时的缺省提前量 */
const DEFAULT_LEAD = 20
/** 服务端允许的最大次数；status 会返回真实值，这里只是首屏兜底 */
const DEFAULT_MAX_QUOTA = 30

/** 把任意值收敛到白名单里的提前量；非法就退回 fallback，再不行用缺省值 */
function normalizeLead(value, fallback) {
  const n = Number(value)
  if (LEAD_OPTIONS.indexOf(n) > -1) return n
  const f = Number(fallback)
  if (LEAD_OPTIONS.indexOf(f) > -1) return f
  return DEFAULT_LEAD
}

function templateId() {
  return config.SUBSCRIBE_TEMPLATE_ID || ''
}

/** 云环境 + 模板 ID 都配了、基础库支持订阅消息才可用 */
function supported() {
  return !!(config.CLOUD_ENV &&
    wx.cloud &&
    templateId() &&
    typeof wx.requestSubscribeMessage === 'function')
}

/* ─────────────── 本地缓存 ─────────────── */

function readCache() {
  const raw = wx.getStorageSync(CACHE_KEY)
  if (!raw || typeof raw !== 'object') return null
  return {
    enabled: !!raw.enabled,
    quota: Math.max(0, Number(raw.quota) || 0),
    needSubscribe: !!raw.needSubscribe,
    leadMinutes: normalizeLead(raw.leadMinutes),
    maxQuota: Math.max(1, Number(raw.maxQuota) || DEFAULT_MAX_QUOTA),
    at: Number(raw.at) || 0
  }
}

function writeCache(status) {
  if (!status || status.ok === false) return
  const prev = readCache()
  wx.setStorageSync(CACHE_KEY, {
    enabled: !!status.enabled,
    quota: Math.max(0, Number(status.quota) || 0),
    needSubscribe: !!status.needSubscribe,
    // 服务端没返回提前量时保留本地值，别把用户刚选的覆盖成缺省
    leadMinutes: normalizeLead(status.leadMinutes, prev && prev.leadMinutes),
    maxQuota: Math.max(1, Number(status.maxQuota) || (prev && prev.maxQuota) || DEFAULT_MAX_QUOTA),
    at: Date.now()
  })
}

/* ─────────────── 云函数 ─────────────── */

function call(action, payload) {
  return new Promise(function (resolve) {
    if (!supported()) {
      resolve({ ok: false, reason: 'unsupported' })
      return
    }
    wx.cloud.callFunction({
      name: 'reminder',
      data: Object.assign({ action: action }, payload || {}),
      success(res) {
        const result = (res && res.result) || {}
        if (result.ok) writeCache(result)
        resolve(result)
      },
      fail(err) {
        const p = store.getProfile() || {}
        console.warn('[reminder] 云函数调用失败 学号=' + (p.studentId || '-') +
          ' 姓名=' + (p.name || '-') + '：' + ((err && err.errMsg) || ''))
        resolve({ ok: false, reason: 'network' })
      }
    })
  })
}

/**
 * 在点击回调里**同步**调用，获取一条订阅额度。
 * 一次授权只换一条消息，所以这里只调一次，不做循环。
 */
function requestSubscription() {
  if (!supported()) return Promise.resolve({ accepted: 0, reason: 'unsupported' })

  const id = templateId()
  return new Promise(function (resolve) {
    wx.requestSubscribeMessage({
      tmplIds: [id],
      success(res) {
        const state = res && res[id]
        // accept = 拿到 1 条；reject / ban / filter = 0 条
        resolve({
          accepted: state === 'accept' ? MAX_PER_TAP : 0,
          reason: state || 'reject'
        })
      },
      fail(err) {
        resolve({ accepted: 0, reason: (err && err.errMsg) || 'fail' })
      }
    })
  })
}

/**
 * 开启提醒。**必须在 tap 回调里调用。**
 *
 * 手里还有次数时直接开启，不弹订阅授权框；
 * 只有次数为 0 才走 requestSubscribeMessage 攒额度。
 *
 * @param {string} studentId 本机记住的学号，服务端据此找云端课表
 * @param {number} [leadMinutes] 课前几分钟提醒
 */
function enable(studentId, leadMinutes) {
  const cache = readCache()
  const lead = normalizeLead(leadMinutes, cache && cache.leadMinutes)
  const profile = store.getProfile() || {}
  const name = String(profile.name || '').trim()

  // 本地没有课表时不走订阅流程（不会弹授权框）
  if (!store.getCourses().length) {
    return Promise.resolve({ ok: false, reason: 'no-local-schedule' })
  }

  // 还有次数：后台补传一次，无论成败都继续开启，不打扰用户
  if (cache && cache.quota > 0) {
    return cloud.ensureBackup().catch(function () {}).then(function () {
      return call('start', { studentId: studentId, name: name, leadMinutes: lead })
    }).then(function (res) {
      return Object.assign({ accepted: 0, reused: true }, res)
    })
  }

  // 次数为 0：先攒额度再开启
  const pending = requestSubscription() // 同步发起，别在这一行之前加 await
  return pending.then(function (sub) {
    if (!sub.accepted) return { ok: false, reason: 'no-accept', accepted: 0 }
    // 攒到授权后静默补传；同步失败也继续开启，下次启动会自动再传
    return cloud.ensureBackup().catch(function () {}).then(function () {
      return call('enable', {
        quota: sub.accepted,
        studentId: studentId,
        name: name,
        leadMinutes: lead
      })
    }).then(function (res) {
      return Object.assign({ accepted: sub.accepted }, res)
    })
  })
}

/** 续订。**必须在 tap 回调里调用。** */
function renew() {
  const pending = requestSubscription()
  return pending.then(function (sub) {
    if (!sub.accepted) return { ok: false, reason: 'no-accept', accepted: 0 }
    return call('addQuota', { count: sub.accepted })
      .then(function (res) {
        return Object.assign({ accepted: sub.accepted }, res)
      })
  })
}

/** 修改课前提醒时间。不涉及订阅授权，随时可以调 */
function setLead(minutes) {
  return call('setLead', { minutes: normalizeLead(minutes) })
}

function disable() {
  return call('disable')
}

/** 从云端拿最新状态；5 分钟内直接用缓存，避免每次进页面都发请求 */
function status(force) {
  const cache = readCache()
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) {
    return Promise.resolve(cache)
  }
  return call('status').then(function (res) {
    return res.ok ? readCache() : cache
  })
}

/**
 * 课表页顶部的续订提示。不需要提示时返回 null。
 * @param {{enabled:boolean, quota:number}|null} state
 */
function tipOf(state) {
  if (!state || !state.enabled) return null
  const quota = Math.max(0, Number(state.quota) || 0)
  if (quota > LOW_QUOTA) return null
  return {
    quota: quota,
    text: quota > 0 ? '上课提醒还剩 ' + quota + ' 次' : '上课提醒已用完'
  }
}

module.exports = {
  MAX_PER_TAP: MAX_PER_TAP,
  LOW_QUOTA: LOW_QUOTA,
  LEAD_OPTIONS: LEAD_OPTIONS,
  DEFAULT_LEAD: DEFAULT_LEAD,
  DEFAULT_MAX_QUOTA: DEFAULT_MAX_QUOTA,
  normalizeLead: normalizeLead,
  supported: supported,
  readCache: readCache,
  enable: enable,
  renew: renew,
  setLead: setLead,
  disable: disable,
  status: status,
  tipOf: tipOf
}
