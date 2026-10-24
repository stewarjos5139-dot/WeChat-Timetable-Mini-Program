/**
 * 上课提醒云函数。
 *
 * 两个入口：
 *   1. 定时触发器（每分钟）—— 算出「20 分钟后要上的课」并发送订阅消息
 *   2. 小程序调用     —— 记录/查询 openid 的提醒开关和剩余额度
 *
 * 身份一律取 getWXContext().OPENID，客户端传什么都不信。
 * 配置见同目录 config.js，部署步骤见根目录《订阅消息提醒.md》。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const config = require('./config')
const tt = require('./timetable')

const REMINDERS = config.COLLECTIONS.reminders
const SCHEDULES = config.COLLECTIONS.schedules

exports.main = async function (event) {
  const wxCtx = cloud.getWXContext()
  const data = event || {}

  // 定时触发器和云开发控制台的测试调用没有 OPENID。
  // 客户端就算伪造 Type:'Timer' 也一定带 OPENID，进不了这条分支。
  if (data.Type === 'Timer' && !wxCtx.OPENID) {
    return onTimer(data)
  }
  return onCall(wxCtx.OPENID, data)
}

/* ───────────────────────── 小程序调用 ───────────────────────── */

async function onCall(openid, data) {
  if (!openid) return { ok: false, reason: 'no-identity' }

  const action = String(data.action || '')
  if (action === 'status') return status(openid)
  if (action === 'enable') return enable(openid, data)
  if (action === 'start') return start(openid, data)
  if (action === 'addQuota') return addQuota(openid, data)
  if (action === 'setLead') return setLead(openid, data)
  if (action === 'disable') return disable(openid)
  return { ok: false, reason: 'bad-action' }
}

async function status(openid) {
  const doc = await getReminder(openid)
  const hasSchedule = !!(doc && doc.studentId && (await getSchedule(doc.studentId)))
  return {
    ok: true,
    enabled: !!(doc && doc.enabled),
    quota: doc ? Math.max(0, Number(doc.quota) || 0) : 0,
    needSubscribe: !!(doc && doc.needSubscribe),
    leadMinutes: normalizeLead(doc && doc.leadMinutes),
    hasSchedule: hasSchedule,
    mode: config.MODE
  }
}

/**
 * 开启提醒。一次性订阅模式下，quota 是这次攒到的条数，累加到已有额度上。
 */
async function enable(openid, data) {
  const quota = clampInt(data.quota, 1, config.MAX_QUOTA_PER_TAP)
  if (!quota) return { ok: false, reason: 'bad-quota' }

  const studentId = String(data.studentId || '').trim()
  if (!/^\d{4,20}$/.test(studentId)) return { ok: false, reason: 'bad-student' }

  // 提醒要用云端备份的课表，没有就直接说清楚，别开一个永远不发消息的开关
  const schedule = await getSchedule(studentId)
  if (!schedule) return { ok: false, reason: 'no-schedule' }

  // 备份是客户端写的，文档带 _openid。拿别人的学号来开提醒读不到别人的课
  if (schedule._openid && schedule._openid !== openid) {
    return { ok: false, reason: 'not-owner' }
  }

  const existing = await getReminder(openid)
  const now = Date.now()
  // 客户端会带上当前选的提前量；没带或非法就沿用原来的，再不行用缺省值
  const lead = normalizeLead(data.leadMinutes, existing && existing.leadMinutes)

  if (existing) {
    const patch = {
      studentId: studentId,
      enabled: true,
      needSubscribe: false,
      leadMinutes: lead,
      updatedAt: now
    }
    if (config.MODE === 'once') {
      patch.quota = Math.min(config.MAX_QUOTA, (Number(existing.quota) || 0) + quota)
    }
    await db.collection(REMINDERS).doc(openid).update({ data: patch })
  } else {
    await db.collection(REMINDERS).add({
      data: {
        _id: openid,
        openid: openid,
        studentId: studentId,
        enabled: true,
        quota: config.MODE === 'once' ? Math.min(config.MAX_QUOTA, quota) : 0,
        needSubscribe: false,
        leadMinutes: lead,
        lastSentDate: '',
        sentKeys: [],
        createdAt: now,
        updatedAt: now
      }
    })
  }

  return status(openid)
}

/**
 * 直接开启提醒，不碰额度。
 * 用户手里还有次数时走这里 —— 小程序端就不会弹订阅授权框。
 * 只有次数为 0 时才走 enable（先攒额度再开启）。
 */
async function start(openid, data) {
  const existing = await getReminder(openid)
  if (!existing) return { ok: false, reason: 'no-quota' }

  if (config.MODE === 'once' && (Number(existing.quota) || 0) <= 0) {
    return { ok: false, reason: 'no-quota' }
  }

  const studentId = String(data.studentId || existing.studentId || '').trim()
  if (!/^\d{4,20}$/.test(studentId)) return { ok: false, reason: 'bad-student' }

  const schedule = await getSchedule(studentId)
  if (!schedule) return { ok: false, reason: 'no-schedule' }
  if (schedule._openid && schedule._openid !== openid) {
    return { ok: false, reason: 'not-owner' }
  }

  const lead = normalizeLead(data.leadMinutes, existing.leadMinutes)

  await db.collection(REMINDERS).doc(openid).update({
    data: {
      studentId: studentId,
      enabled: true,
      needSubscribe: false,
      leadMinutes: lead,
      updatedAt: Date.now()
    }
  })

  return status(openid)
}

/** 续订：把新攒到的条数加到剩余额度上 */
async function addQuota(openid, data) {
  const count = clampInt(data.count, 1, config.MAX_QUOTA_PER_TAP)
  if (!count) return { ok: false, reason: 'bad-count' }

  const existing = await getReminder(openid)
  if (!existing) return { ok: false, reason: 'not-enabled' }

  if (config.MODE === 'long') return status(openid)

  await db.collection(REMINDERS).doc(openid).update({
    data: {
      quota: Math.min(config.MAX_QUOTA, (Number(existing.quota) || 0) + count),
      enabled: true,
      needSubscribe: false,
      updatedAt: Date.now()
    }
  })
  return status(openid)
}

/**
 * 修改课前提醒时间。用户记录不存在时先建一条 enabled:false 的记录，
 * 这样「还没开启就先设好时间」也能持久化，下次开启直接沿用。
 */
async function setLead(openid, data) {
  const minutes = Number(data.minutes)
  if (config.ALLOWED_LEAD_MINUTES.indexOf(minutes) === -1) {
    return { ok: false, reason: 'bad-lead' }
  }

  const existing = await getReminder(openid)
  const now = Date.now()

  if (existing) {
    await db.collection(REMINDERS).doc(openid).update({
      data: { leadMinutes: minutes, updatedAt: now }
    })
  } else {
    await db.collection(REMINDERS).add({
      data: {
        _id: openid,
        openid: openid,
        enabled: false,
        quota: 0,
        needSubscribe: false,
        leadMinutes: minutes,
        lastSentDate: '',
        sentKeys: [],
        createdAt: now,
        updatedAt: now
      }
    })
  }

  return status(openid)
}

async function disable(openid) {
  const existing = await getReminder(openid)
  if (!existing) return status(openid)
  await db.collection(REMINDERS).doc(openid).update({
    data: { enabled: false, updatedAt: Date.now() }
  })
  return status(openid)
}

/* ───────────────────────── 定时触发 ───────────────────────── */

async function onTimer(event) {
  const now = event.__now ? new Date(event.__now) : new Date()
  if (isNaN(now.getTime())) return { ok: false, reason: 'bad-now' }
  if (!config.TEMPLATE_ID) return { ok: false, reason: 'no-template' }

  const t = tt.beijingParts(now)

  // 廉价早退：绝大多数分钟直接在这里返回，不碰数据库。
  // 每个用户可能选不同的提前量，所以按允许值的全集来判断
  if (!tt.isReminderMinute(t.minutes, config.ALLOWED_LEAD_MINUTES)) {
    return { ok: true, skipped: 'minute' }
  }

  const users = await readEnabled()
  let sent = 0
  let failed = 0

  for (let i = 0; i < users.length; i++) {
    try {
      const r = await remindUser(users[i], t)
      sent += r.sent
      failed += r.failed
    } catch (err) {
      failed++
      console.error('[reminder] 用户处理失败', users[i] && users[i]._id, errMsg(err))
    }
  }

  return { ok: true, users: users.length, sent: sent, failed: failed }
}

/** 给一个用户发这一分钟该发的提醒；返回本次发送条数 */
async function remindUser(doc, t) {
  const schedule = await getSchedule(doc.studentId)
  if (!schedule || !Array.isArray(schedule.courses)) return { sent: 0, failed: 0 }

  const week = tt.weekOf(schedule.term || {}, t)
  if (!week) return { sent: 0, failed: 0 }

  // 每个用户可以在小程序里自己设「课前几分钟」
  const lead = normalizeLead(doc.leadMinutes)

  const matches = tt.matchCourses(schedule.courses, {
    weekday: t.weekday,
    week: week,
    minutes: t.minutes
  }, lead)
  if (!matches.length) return { sent: 0, failed: 0 }

  // 同一天已经发过的（日期#课程id）不再发 —— 定时器延迟重跑也不会重复
  const sameDay = doc.lastSentDate === t.dateKey
  const sentKeys = sameDay && Array.isArray(doc.sentKeys) ? doc.sentKeys.slice() : []
  let quota = Number(doc.quota) || 0
  let needSubscribe = !!doc.needSubscribe
  let noSubscription = false // 43101：微信侧已经没有可用订阅，额度必须清零
  let sent = 0
  let failed = 0

  for (let i = 0; i < matches.length; i++) {
    const item = matches[i]
    const key = t.dateKey + '#' + item.course.id
    if (sentKeys.indexOf(key) > -1) continue

    if (config.MODE === 'once' && quota <= 0) {
      needSubscribe = true // 额度用完，等用户回来续订
      break
    }

    try {
      await sendMessage(doc.openid || doc._id, item.course, item.start, t, lead)
      sent++
      sentKeys.push(key)
      if (config.MODE === 'once') quota = Math.max(0, quota - 1)
    } catch (err) {
      failed++
      const code = errCode(err)
      console.error('[reminder] 发送失败', key, code, errMsg(err))
      // 43101：用户没有可用订阅（拒绝过 / 关掉了模板 / 额度用尽）
      if (code === 43101) {
        needSubscribe = true
        noSubscription = true
        break
      }
    }
  }

  // 次数用完（或微信侧已经没有可用订阅）就自动关掉提醒，
  // 不挂着一个永远发不出去的开关注记
  const autoOff = config.MODE === 'once' && (noSubscription || quota <= 0)

  const changed = autoOff ||
    sent > 0 ||
    sentKeys.length !== (sameDay && Array.isArray(doc.sentKeys) ? doc.sentKeys.length : 0) ||
    needSubscribe !== !!doc.needSubscribe

  if (changed) {
    const data = {
      lastSentDate: t.dateKey,
      sentKeys: sentKeys.slice(-50), // 只留最近的，够跨天去重就行
      needSubscribe: needSubscribe,
      updatedAt: Date.now()
    }
    // 用自减而不是写绝对值：用户可能正好在这一分钟点了续订
    if (config.MODE === 'once') {
      data.quota = noSubscription ? 0 : _.inc(-sent)
      if (autoOff) {
        data.enabled = false
        data.needSubscribe = true
      }
    }
    // 长期订阅被用户在微信里关掉后，直接停掉，下次开启会重新授权
    if (config.MODE === 'long' && needSubscribe) data.enabled = false
    await db.collection(REMINDERS).doc(doc._id).update({ data: data })
  }

  return { sent: sent, failed: failed }
}

async function sendMessage(openid, course, startMinutes, t, leadMinutes) {
  if (!openid) throw new Error('缺少 openid')

  const tip = String(config.TIP_TEXT || '').replace('{lead}', String(leadMinutes))
  const values = {
    countdown: clip(tip, 5),          // short_thing 限 5 个字符
    course: clip(course.name, 20),    // thing 限 20 个字符
    teacher: clip(course.teacher || '未填写', 20),
    time: timeValue(startMinutes, t),
    room: clip(course.room || '待定', 20)
  }

  const data = {}
  Object.keys(config.FIELDS).forEach(function (key) {
    const field = config.FIELDS[key]
    if (!field || values[key] === undefined) return
    data[field] = { value: values[key] }
  })
  if (!Object.keys(data).length) throw new Error('模板字段未配置')

  return cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId: config.TEMPLATE_ID,
    page: config.PAGE,
    data: data,
    miniprogramState: config.MINIPROGRAM_STATE,
    lang: 'zh_CN'
  })
}

/* ───────────────────────── 小工具 ───────────────────────── */

async function getReminder(openid) {
  const res = await db.collection(REMINDERS).where({ _id: openid }).limit(1).get()
  return (res.data && res.data[0]) || null
}

async function getSchedule(studentId) {
  if (!studentId) return null
  const res = await db.collection(SCHEDULES).where({ _id: studentId }).limit(1).get()
  return (res.data && res.data[0]) || null
}

async function readEnabled() {
  const PAGE = 100
  const out = []
  for (let skip = 0; skip < 10000; skip += PAGE) {
    const res = await db.collection(REMINDERS).where({ enabled: true }).skip(skip).limit(PAGE).get()
    const list = res.data || []
    out.push.apply(out, list)
    if (list.length < PAGE) break
  }
  return out
}

/**
 * 只接受白名单里的提前量。依次尝试 value → fallback → 缺省值。
 * 旧数据里没有 leadMinutes 时就会落到缺省值。
 */
function normalizeLead(value, fallback) {
  const allowed = config.ALLOWED_LEAD_MINUTES
  const n = Number(value)
  if (allowed.indexOf(n) > -1) return n
  const f = Number(fallback)
  if (allowed.indexOf(f) > -1) return f
  return config.LEAD_MINUTES
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value))
  if (!isFinite(n) || n < min) return 0
  return Math.min(n, max)
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function timeValue(startMinutes, t) {
  const hh = pad2(Math.floor(startMinutes / 60))
  const mm = pad2(startMinutes % 60)
  if (config.TIME_FORMAT === 'time') return hh + ':' + mm
  // time 型要求「2026年10月24日 08:00」或纯「08:00」，带上年份最稳
  const date = t.year + '年' + (t.month + 1) + '月' + t.day + '日'
  if (config.TIME_FORMAT === 'date') return date
  return date + ' ' + hh + ':' + mm
}

/** 模板的 thing 类字段通常限 20 字，超了会整条发送失败 */
function clip(text, max) {
  const s = String(text === undefined || text === null ? '' : text).trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function errCode(err) {
  if (!err) return 0
  return Number(err.errCode || err.errcode || err.code || 0) || 0
}

function errMsg(err) {
  if (!err) return ''
  return err.errMsg || err.errmsg || err.message || String(err)
}
