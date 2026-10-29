/**
 * 后台管理云函数。
 *
 * 只做一件事：把运营数据聚起来给「小程序内的管理页」用。
 * 每一个 action 都先校验 openid，前端藏不藏页面只影响体验，不影响安全。
 *
 * 数据全部来自云数据库，这个函数不需要 openapi 权限。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const config = require('./config')

const SCHEDULES = config.COLLECTIONS.schedules
const REMINDERS = config.COLLECTIONS.reminders
const LOGS = config.COLLECTIONS.logs
const NOTICES = config.COLLECTIONS.notices

exports.main = async function (event) {
  const wxCtx = cloud.getWXContext()
  const openid = wxCtx.OPENID
  const data = event || {}
  const action = String(data.action || '')

  // 查自己的 openid。只返回调用者自己的，不碰任何数据，所以放在鉴权之前。
  // 第一次配白名单时用它，免得去数据库里翻。
  if (action === 'whoami') return { ok: true, openid: openid || '' }

  if (config.ADMIN_OPENIDS.indexOf(openid) === -1) {
    return {
      ok: false,
      reason: 'forbidden',
      hint: '当前 openid 不在 ADMIN_OPENIDS 里，先用 whoami 查出来，加进 config.js 后重新部署'
    }
  }

  if (action === 'stats') return stats()
  if (action === 'users') return users(data)
  if (action === 'userDetail') return userDetail(data)
  if (action === 'logs') return logs(data)
  if (action === 'noticeGet') return noticeGet()

  if (action === 'deleteSchedule') return deleteSchedule(openid, data)
  if (action === 'closeReminder') return closeReminder(openid, data)
  if (action === 'clearLogs') return clearLogs(openid, data)
  if (action === 'noticeSave') return noticeSave(openid, data, false)
  if (action === 'noticePublish') return noticeSave(openid, data, true)
  if (action === 'noticeToggle') return noticeToggle(openid, data)

  return { ok: false, reason: 'bad-action' }
}

/* ───────────────────────── 概览 ───────────────────────── */

async function stats() {
  const scheduleCount = await safeCount(SCHEDULES)
  const reminderCount = await safeCount(REMINDERS)
  const enabledCount = await safeCount(REMINDERS, { enabled: true })

  // 剩余额度合计：开启提醒的记录量很小，直接全读回来加
  let quotaTotal = 0
  try {
    const list = await readAll(REMINDERS, { enabled: true })
    list.forEach(function (r) { quotaTotal += Number(r.quota) || 0 })
  } catch (err) {
    quotaTotal = -1
  }

  const today = beijingDateKey(new Date())
  let scansToday = 0
  let sentToday = 0
  let failedToday = 0
  try {
    const scans = await readLogs('scan', 200)
    scans.forEach(function (l) {
      if (l.dateKey !== today) return
      scansToday++
      sentToday += Number(l.sent) || 0
      failedToday += Number(l.failed) || 0
    })
  } catch (err) {
    scansToday = -1
  }

  let lastHeartbeat = null
  try {
    const hb = await readLogs('heartbeat', 5)
    lastHeartbeat = hb.length ? (Number(hb[0].at) || 0) : null
  } catch (err) {
    lastHeartbeat = null
  }

  return {
    ok: true,
    stats: {
      scheduleCount: scheduleCount,
      reminderCount: reminderCount,
      enabledCount: enabledCount,
      quotaTotal: quotaTotal,
      scansToday: scansToday,
      sentToday: sentToday,
      failedToday: failedToday,
      lastHeartbeat: lastHeartbeat,
      today: today
    }
  }
}

/* ───────────────────────── 用户 ───────────────────────── */

async function users(data) {
  const page = Math.max(1, Number(data.page) || 1)
  const size = Math.min(50, Math.max(1, Number(data.size) || 20))
  const keyword = String(data.keyword || '').trim().toLowerCase()

  const schedules = await readAll(SCHEDULES)
  const reminders = await readAll(REMINDERS)

  // 同一学号可能有历史遗留的多条提醒记录，只留最近更新的那条
  const remByStudent = {}
  reminders.forEach(function (r) {
    const id = String(r.studentId || '').trim()
    if (!id) return
    const prev = remByStudent[id]
    if (!prev || (Number(r.updatedAt) || 0) > (Number(prev.updatedAt) || 0)) remByStudent[id] = r
  })

  const rows = []
  const seen = {}

  schedules.forEach(function (doc) {
    const id = String(doc._id || '')
    seen[id] = true
    const profile = doc.profile || {}
    const rem = remByStudent[id] || null
    rows.push({
      studentId: id,
      name: profile.name || (rem && rem.name) || '',
      courseCount: Array.isArray(doc.courses) ? doc.courses.length : 0,
      updatedAt: Number(doc.updatedAt) || 0,
      hasSchedule: true,
      reminder: rem ? pickReminder(rem) : null
    })
  })

  // 有提醒记录、但云端课表已经没了 —— 这类用户的提醒必然发不出去，要能看见
  Object.keys(remByStudent).forEach(function (id) {
    if (seen[id]) return
    const rem = remByStudent[id]
    rows.push({
      studentId: id,
      name: rem.name || '',
      courseCount: 0,
      updatedAt: Number(rem.updatedAt) || 0,
      hasSchedule: false,
      reminder: pickReminder(rem)
    })
  })

  rows.sort(function (a, b) { return b.updatedAt - a.updatedAt })

  const filtered = keyword
    ? rows.filter(function (r) {
      return String(r.studentId).toLowerCase().indexOf(keyword) > -1 ||
        String(r.name).toLowerCase().indexOf(keyword) > -1
    })
    : rows

  const start = (page - 1) * size
  return {
    ok: true,
    total: filtered.length,
    page: page,
    size: size,
    rows: filtered.slice(start, start + size)
  }
}

function pickReminder(rem) {
  return {
    enabled: !!rem.enabled,
    quota: Number(rem.quota) || 0,
    leadMinutes: Number(rem.leadMinutes) || 0,
    name: rem.name || '',
    lastSentDate: rem.lastSentDate || '',
    updatedAt: Number(rem.updatedAt) || 0
  }
}

async function userDetail(data) {
  const studentId = String(data.studentId || '').trim()
  if (!studentId) return { ok: false, reason: 'bad-student' }

  let schedule = null
  try {
    const res = await db.collection(SCHEDULES).where({ _id: studentId }).limit(1).get()
    schedule = (res.data && res.data[0]) || null
  } catch (err) {
    schedule = null
  }

  let reminder = null
  try {
    const res = await db.collection(REMINDERS).where({ studentId: studentId }).limit(1).get()
    reminder = (res.data && res.data[0]) || null
  } catch (err) {
    reminder = null
  }

  let logs = []
  try {
    const all = await readLogs(null, config.MAX_LOGS)
    logs = all.filter(function (l) {
      return String(l.studentId || '') === studentId
    }).slice(0, 20)
  } catch (err) {
    logs = []
  }

  const courses = (schedule && Array.isArray(schedule.courses)) ? schedule.courses : []

  return {
    ok: true,
    studentId: studentId,
    hasSchedule: !!schedule,
    updatedAt: schedule ? (Number(schedule.updatedAt) || 0) : 0,
    term: (schedule && schedule.term) || null,
    courses: courses.map(function (c) {
      return {
        id: c.id,
        name: c.name || '',
        day: Number(c.day) || 0,
        start: Number(c.start) || 0,
        span: Number(c.span) || 1,
        room: c.room || '',
        teacher: c.teacher || '',
        weekText: weekTextOf(c)
      }
    }),
    reminder: reminder ? Object.assign(pickReminder(reminder), {
      needSubscribe: !!reminder.needSubscribe,
      sentKeys: Array.isArray(reminder.sentKeys) ? reminder.sentKeys.length : 0
    }) : null,
    logs: logs
  }
}

function weekTextOf(c) {
  if (Array.isArray(c.weekList) && c.weekList.length) return c.weekList.join(',')
  if (!Array.isArray(c.weeks) || c.weeks.length < 2) return ''
  const parity = c.parity === 'odd' ? ' 单周' : (c.parity === 'even' ? ' 双周' : '')
  return c.weeks[0] + '-' + c.weeks[1] + parity
}

/* ───────────────────────── 日志 ───────────────────────── */

async function logs(data) {
  const page = Math.max(1, Number(data.page) || 1)
  const size = Math.min(50, Math.max(1, Number(data.size) || 20))
  const type = ['action', 'scan', 'heartbeat', 'admin'].indexOf(String(data.type || '')) > -1
    ? String(data.type)
    : ''

  const all = await readLogs(type || null, config.MAX_LOGS)
  const start = (page - 1) * size

  return {
    ok: true,
    total: all.length,
    page: page,
    size: size,
    rows: all.slice(start, start + size).map(function (l) {
      return {
        at: Number(l.at) || 0,
        type: l.type || '',
        time: l.time || '',
        action: l.action || '',
        studentId: l.studentId || '',
        name: l.name || '',
        count: l.count,
        quota: l.quota,
        sent: l.sent,
        failed: l.failed,
        users: l.users,
        result: l.result || '',
        details: Array.isArray(l.details) ? l.details : null
      }
    })
  }
}

/* ───────────────────────── 公告 ───────────────────────── */

async function readNotice() {
  // 先按约定的固定 _id 找
  const res = await db.collection(NOTICES).where({ _id: config.NOTICE_ID }).limit(1).get()
  if (res.data && res.data[0]) return res.data[0]

  // 兜底：手动在控制台建过公告时 _id 是随机的，取任意一条，
  // 否则每次发布都会因为读不到旧版本而把版本号一直写成 1
  const any = await db.collection(NOTICES).limit(1).get()
  return (any.data && any.data[0]) || null
}

async function noticeGet() {
  try {
    return { ok: true, notice: await readNotice() }
  } catch (err) {
    return { ok: false, reason: 'read-failed', message: errMsg(err) }
  }
}

async function noticeSave(openid, data, publish) {
  const title = String(data.title || '').trim().slice(0, 40)
  const body = String(data.body || '').trim().slice(0, 2000)
  if (!title) return { ok: false, reason: 'no-title' }
  if (!body) return { ok: false, reason: 'no-body' }

  let existing = null
  try {
    existing = await readNotice()
  } catch (err) {
    return {
      ok: false,
      reason: 'no-collection',
      message: '请先在云开发控制台新建 notices 集合（权限：所有用户可读）'
    }
  }

  const current = Number(existing && existing.version) || 0
  const payload = {
    title: title,
    body: body,
    // 保存草稿只改内容、不动开关；开关由「弹窗开关」单独控制。
    // 只有「发布」才强制打开并递增批次，让所有人都重新看到一次
    active: publish ? true : !!(existing && existing.active),
    version: publish ? current + 1 : current,
    updatedAt: Date.now()
  }

  try {
    if (existing && existing._id) {
      await db.collection(NOTICES).doc(existing._id).update({ data: payload })
    } else {
      await db.collection(NOTICES).add({
        data: Object.assign({ _id: config.NOTICE_ID }, payload)
      })
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'write-failed',
      message: '写入公告失败，确认 notices 集合已建好（权限：所有用户可读）：' + errMsg(err)
    }
  }

  await audit(openid, publish ? 'noticePublish' : 'noticeSave', '', {
    version: payload.version,
    active: payload.active
  })

  const savedId = (existing && existing._id) || config.NOTICE_ID
  return { ok: true, notice: Object.assign({ _id: savedId }, payload) }
}

/**
 * 弹窗总开关。关掉之后，即使公告内容还在、还有人没看过，也不会再弹。
 *
 * 只改 active，不动内容和批次：
 *   - 关掉再打开：看过的人不再弹，没看过的人会看到
 *   - 想让所有人都重新看一次，用「发布」
 */
async function noticeToggle(openid, data) {
  const active = !!data.active

  let existing = null
  try {
    existing = await readNotice()
  } catch (err) {
    return { ok: false, reason: 'no-collection', message: 'notices 集合还没建好：' + errMsg(err) }
  }
  if (!existing) {
    return { ok: false, reason: 'no-notice', message: '还没有公告内容，先写一条并保存' }
  }

  const patch = { active: active, updatedAt: Date.now() }

  // 从没发布过的草稿（批次 0）被打开时给一个初始批次。
  // 客户端判断的是「批次大于本地记录」，批次一直是 0 就永远弹不出来
  if (active && !(Number(existing.version) > 0)) patch.version = 1

  try {
    await db.collection(NOTICES).doc(existing._id).update({ data: patch })
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: errMsg(err) }
  }

  await audit(openid, 'noticeToggle', '', { active: active })
  return {
    ok: true,
    active: active,
    version: patch.version || Number(existing.version) || 0
  }
}

/* ───────────────────────── 写操作 ───────────────────────── */

async function deleteSchedule(openid, data) {
  const studentId = String(data.studentId || '').trim()
  if (!studentId) return { ok: false, reason: 'bad-student' }

  try {
    await db.collection(SCHEDULES).doc(studentId).remove()
  } catch (err) {
    return { ok: false, reason: 'remove-failed', message: errMsg(err) }
  }

  await audit(openid, 'deleteSchedule', studentId)
  return { ok: true }
}

async function closeReminder(openid, data) {
  const studentId = String(data.studentId || '').trim()
  if (!studentId) return { ok: false, reason: 'bad-student' }

  try {
    const res = await db.collection(REMINDERS).where({ studentId: studentId }).update({
      data: { enabled: false, needSubscribe: true, updatedAt: Date.now() }
    })
    const updated = (res.stats && res.stats.updated) || 0
    await audit(openid, 'closeReminder', studentId, { updated: updated })
    return { ok: true, updated: updated }
  } catch (err) {
    return { ok: false, reason: 'update-failed', message: errMsg(err) }
  }
}

async function clearLogs(openid, data) {
  const beforeTs = Number(data.beforeTs) || 0
  if (!beforeTs) return { ok: false, reason: 'bad-time' }

  let removed = 0
  try {
    for (let i = 0; i < 10; i++) {
      const res = await db.collection(LOGS).where({ at: _.lt(beforeTs) }).remove()
      const n = (res.stats && res.stats.removed) || 0
      removed += n
      if (n < 100) break
    }
  } catch (err) {
    return { ok: false, reason: 'remove-failed', message: errMsg(err) }
  }

  await audit(openid, 'clearLogs', '', { beforeTs: beforeTs, removed: removed })
  return { ok: true, removed: removed }
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 审计记录：谁在什么时候动了什么，方便事后回溯 */
async function audit(openid, action, studentId, extra) {
  try {
    await db.collection(LOGS).add({
      data: Object.assign({
        at: Date.now(),
        type: 'admin',
        action: action,
        studentId: studentId || '',
        openidTail: String(openid || '').slice(-6)
      }, extra || {})
    })
  } catch (err) {
    // 记不上审计不影响操作本身
  }
}

async function safeCount(name, where) {
  try {
    let q = db.collection(name)
    if (where) q = q.where(where)
    const res = await q.count()
    return Number(res.total) || 0
  } catch (err) {
    return -1
  }
}

/**
 * 分页把整个集合读回来。
 * 后台是给自己用的，数据量在这个量级下，内存里排序比在数据库里配索引简单也更不容易出问题。
 */
async function readAll(name, where, max) {
  const cap = Math.min(max || config.MAX_USERS, 10000)
  const PAGE = 100
  const out = []

  for (let skip = 0; skip < cap; skip += PAGE) {
    let q = db.collection(name)
    if (where) q = q.where(where)
    const res = await q.skip(skip).limit(Math.min(PAGE, cap - skip)).get()
    const list = res.data || []
    out.push.apply(out, list)
    if (list.length < PAGE) break
  }
  return out
}

/** 读日志，按时间倒序。type 为空表示全部类型 */
async function readLogs(type, max) {
  const cap = Math.min(max || config.MAX_LOGS, 1000)
  const PAGE = 100
  const out = []

  for (let skip = 0; skip < cap; skip += PAGE) {
    let q = db.collection(LOGS)
    if (type) q = q.where({ type: type })
    const res = await q.skip(skip).limit(Math.min(PAGE, cap - skip)).get()
    const list = res.data || []
    out.push.apply(out, list)
    if (list.length < PAGE) break
  }

  out.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0) })
  return out
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 北京时间的日期键，和提醒日志里的 dateKey 同一格式 */
function beijingDateKey(date) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000)
  return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate())
}

function errMsg(err) {
  if (!err) return ''
  return err.errMsg || err.errmsg || err.message || String(err)
}
