/**
 * 上课提醒云函数。
 *
 * 两个入口：
 *   1. 定时触发器（课前 60 分钟内每 5 分钟）—— 算出该提醒的课并发送订阅消息
 *   2. 小程序调用     —— 记录/查询 openid 的提醒开关和剩余额度
 *
 * 身份一律取 getWXContext().OPENID，客户端传什么都不信。
 * 配置见同目录 config.js，部署步骤见根目录《订阅消息提醒.md》。
 */

const https = require('https')
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

  // 诊断只读接口：小程序端看自己，云开发控制台可以按学号看或看总览，
  // 所以要在 onCall 的 OPENID 校验之前处理
  if (data.action === 'debug') {
    return debug(wxCtx.OPENID, data)
  }

  // 看看 access_token 兜底通道通不通（不发消息，只换一次 token）
  if (data.action === 'probeToken') {
    return probeToken()
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
  if (action === 'sendTest') return sendTest(openid, data)
  if (action === 'testReminder') return testReminder(openid, data)
  if (action === 'quotaTrail') return quotaTrail(openid)
  return { ok: false, reason: 'bad-action' }
}

/**
 * 额度流水：现在的 quota 是怎么累加出来的。只读，不改数据、不发消息。
 * 代码里只有 enable（首次开启）和 addQuota（获取次数）会加额度，
 * 所以每条 action 日志的 count 加起来就是 quota 的来源。
 */
async function quotaTrail(openid) {
  const doc = await getReminder(openid)
  const studentId = String((doc && doc.studentId) || '').trim()

  let logs = []
  try {
    // 不用 orderBy，免得要额外建索引；取回来在内存里排
    const res = await db.collection(config.COLLECTIONS.logs)
      .where({ studentId: studentId })
      .limit(100)
      .get()
    logs = (res.data || [])
      .filter(function (l) { return l.type !== 'scan' })
      .sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0) })
      .map(function (l) {
        return {
          time: formatAt(l.at),
          action: l.action || '',
          count: l.count,
          quota: l.quota,
          leadMinutes: l.leadMinutes
        }
      })
  } catch (err) {
    // 集合没建 / 没权限都当作没有流水
    logs = []
  }

  let added = 0
  logs.forEach(function (l) { added += Number(l.count) || 0 })

  return {
    ok: true,
    // 部署上去的这份云函数用的常量。和本地 config.js 对不上就说明没重新上传
    config: {
      MAX_QUOTA: config.MAX_QUOTA,
      MAX_QUOTA_PER_TAP: config.MAX_QUOTA_PER_TAP,
      MODE: config.MODE,
      LEAD_MINUTES: config.LEAD_MINUTES,
      BLOCK_START_SECTIONS: config.BLOCK_START_SECTIONS
    },
    reminder: doc ? {
      quota: Number(doc.quota) || 0,
      enabled: !!doc.enabled,
      studentId: doc.studentId || '',
      name: doc.name || '',
      leadMinutes: doc.leadMinutes,
      createdAt: formatAt(doc.createdAt),
      updatedAt: formatAt(doc.updatedAt),
      lastSentDate: doc.lastSentDate || '',
      sentToday: (doc.sentKeys || []).length
    } : null,
    added: added,
    logs: logs
  }
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
    maxQuota: config.MAX_QUOTA,
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
  const name = cleanName(data.name)

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
      name: name || existing.name || '',
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
        name: name,
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

  const res = await status(openid)
  console.log('[reminder] 开启 ' + whoOf({ studentId: studentId, name: name }) +
    ' 额度=' + res.quota + ' 提前=' + lead + '分钟')
  await writeLog({ type: 'action', action: 'enable', studentId: studentId, name: name,
    quota: res.quota, leadMinutes: lead })
  return res
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
  const name = cleanName(data.name) || cleanName(existing.name)

  const schedule = await getSchedule(studentId)
  if (!schedule) return { ok: false, reason: 'no-schedule' }
  if (schedule._openid && schedule._openid !== openid) {
    return { ok: false, reason: 'not-owner' }
  }

  const lead = normalizeLead(data.leadMinutes, existing.leadMinutes)

  await db.collection(REMINDERS).doc(openid).update({
    data: {
      studentId: studentId,
      name: name,
      enabled: true,
      needSubscribe: false,
      leadMinutes: lead,
      updatedAt: Date.now()
    }
  })

  const res = await status(openid)
  console.log('[reminder] 开启（复用次数） ' + whoOf({ studentId: studentId, name: name }) +
    ' 额度=' + res.quota + ' 提前=' + lead + '分钟')
  await writeLog({ type: 'action', action: 'start', studentId: studentId, name: name,
    quota: res.quota, leadMinutes: lead })
  return res
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
  const res = await status(openid)
  console.log('[reminder] 获取次数 ' + whoOf(existing) + ' 增加=' + count + ' 现有=' + res.quota)
  await writeLog({ type: 'action', action: 'addQuota', studentId: existing.studentId || '',
    name: existing.name || '', count: count, quota: res.quota })
  return res
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

  const res = await status(openid)
  console.log('[reminder] 修改提前量 ' +
    (existing ? whoOf(existing) : 'openid尾号=' + String(openid).slice(-6)) +
    ' 分钟=' + minutes)
  await writeLog({ type: 'action', action: 'setLead',
    studentId: (existing && existing.studentId) || '', name: (existing && existing.name) || '',
    minutes: minutes })
  return res
}

async function disable(openid) {
  const existing = await getReminder(openid)
  if (!existing) return status(openid)
  await db.collection(REMINDERS).doc(openid).update({
    data: { enabled: false, updatedAt: Date.now() }
  })
  const res = await status(openid)
  console.log('[reminder] 关闭 ' + whoOf(existing))
  await writeLog({ type: 'action', action: 'disable',
    studentId: existing.studentId || '', name: existing.name || '' })
  return res
}

/* ───────────────────────── 诊断 ───────────────────────── */

/**
 * 诊断：把「现在该不该发、卡在哪一步」一次性返回，只读、不写库。
 * 小程序端调用只看自己；云开发控制台调用（没有 OPENID）可以传 studentId，
 * 不传就返回所有已开启提醒的用户概览。
 */
async function debug(openid, data) {
  const now = data.__now ? new Date(data.__now) : new Date()
  if (isNaN(now.getTime())) return { ok: false, reason: 'bad-now' }

  const t = tt.beijingParts(now)

  if (!openid) {
    if (data.studentId) {
      const res = await db.collection(REMINDERS)
        .where({ studentId: String(data.studentId) })
        .limit(1)
        .get()
      const doc = (res.data && res.data[0]) || null
      if (!doc) return { ok: false, reason: 'no-reminder', studentId: String(data.studentId) }
      return inspect(doc, t)
    }

    const users = await readEnabled()
    return {
      ok: true,
      now: describeNow(t),
      note: '未指定 studentId，返回所有已开启提醒的用户概览',
      count: users.length,
      users: users.slice(0, 20).map(function (u) {
        return {
          studentId: u.studentId || '',
          openidTail: String(u.openid || u._id || '').slice(-8),
          quota: Number(u.quota) || 0,
          leadMinutes: normalizeLead(u.leadMinutes),
          lastSentDate: u.lastSentDate || ''
        }
      })
    }
  }

  const doc = await getReminder(openid)
  if (!doc) return { ok: false, reason: 'no-reminder' }
  return inspect(doc, t)
}

/** 给一条提醒记录做体检 */
async function inspect(doc, t) {
  const lead = normalizeLead(doc.leadMinutes)
  const result = {
    ok: true,
    now: describeNow(t),
    reminder: {
      enabled: !!doc.enabled,
      quota: Number(doc.quota) || 0,
      needSubscribe: !!doc.needSubscribe,
      leadMinutes: lead,
      studentId: doc.studentId || '',
      name: doc.name || '',
      lastSentDate: doc.lastSentDate || '',
      sentKeys: doc.sentKeys || []
    },
    schedule: null,
    week: 0,
    today: [],
    wouldFireNow: [],
    nextReminder: '',
    hints: []
  }

  const schedule = await getSchedule(doc.studentId)
  if (!schedule) {
    result.hints.push('云端没有这份学号的课表备份（schedules 集合），提醒不会触发')
    return result
  }

  const courses = Array.isArray(schedule.courses) ? schedule.courses : []
  result.schedule = {
    exists: true,
    courses: courses.length,
    updatedAt: schedule.updatedAt || null,
    term: schedule.term || null
  }

  const week = tt.weekOf(schedule.term || {}, t)
  result.week = week
  if (!week) {
    result.hints.push('按 term.startDate 算，今天不在学期周次范围内（检查开学周一是否填对）')
    return result
  }

  const todays = courses.filter(function (c) {
    return c && c.day === t.weekday && tt.isActiveInWeek(c, week)
  })

  result.today = todays.map(function (c) {
    const span = Number(c.span) || 1
    const start = tt.sectionStart(c.start)
    const end = tt.sectionEnd(Number(c.start) + span - 1)
    return {
      name: c.name,
      section: span > 1 ? c.start + '-' + (Number(c.start) + span - 1) : String(c.start),
      time: isNaN(start) || isNaN(end) ? '' : hhmm(start) + '-' + hhmm(end),
      remindAt: isNaN(start) ? '' : hhmm(start - lead),
      weeks: weekText(c)
    }
  })

  result.wouldFireNow = tt.matchCourses(courses, {
    weekday: t.weekday,
    week: week,
    minutes: t.minutes
  }, lead, config.BLOCK_START_SECTIONS).map(function (m) { return m.course.name })

  const upcoming = todays
    .filter(function (c) { return config.BLOCK_START_SECTIONS.indexOf(Number(c.start)) > -1 })
    .map(function (c) { return { course: c, start: tt.sectionStart(c.start) } })
    .filter(function (x) { return !isNaN(x.start) && x.start - lead >= t.minutes })
    .sort(function (a, b) { return a.start - b.start })
  if (upcoming.length) {
    result.nextReminder = hhmm(upcoming[0].start - lead) + ' 提醒 ' + upcoming[0].course.name
  }

  if (!doc.enabled) result.hints.push('提醒当前是关闭的：去「我的 → 提醒」打开')
  if (config.MODE === 'once' && (Number(doc.quota) || 0) <= 0) {
    result.hints.push('剩余次数为 0：点「获取次数」后再开启')
  }
  if (doc.needSubscribe) result.hints.push('微信侧没有可用订阅：需要重新授权')
  if (!todays.length) result.hints.push('今天没有这门课表里要上的课')
  if (todays.length && !result.nextReminder && !result.wouldFireNow.length) {
    result.hints.push('今天剩下的课都已经过了提醒时间')
  }
  if (result.wouldFireNow.length) {
    result.hints.push('当前时刻正好命中提醒窗口：如果没收到消息，问题在定时触发器或云函数日志')
  }

  return result
}

function hhmm(minutes) {
  const m = Number(minutes)
  if (!isFinite(m)) return ''
  const v = ((m % 1440) + 1440) % 1440
  return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60)
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function describeNow(t) {
  return t.dateKey + ' ' + hhmm(t.minutes) + ' ' + (WEEKDAY_NAMES[t.weekday] || '')
}

function weekText(course) {
  if (Array.isArray(course.weekList)) {
    return course.weekList.length > 4
      ? course.weekList[0] + '~' + course.weekList[course.weekList.length - 1] + '（共' + course.weekList.length + '周）'
      : course.weekList.join(',')
  }
  if (!course.weeks || course.weeks.length < 2) return ''
  return course.weeks[0] + '-' + course.weeks[1] +
    (course.parity ? '（' + (course.parity === 'odd' ? '单周' : '双周') + '）' : '')
}

/**
 * 从今天起找最近一次真实会上的课（最多向后看 21 天）。
 * 返回 { course, start, parts, offset }，parts 是那天的日期（含星期）。
 */
function nextCourseOccurrence(courses, term, nowParts, sections) {
  const base = Date.UTC(nowParts.year, nowParts.month, nowParts.day)

  for (let offset = 0; offset <= 21; offset++) {
    const d = new Date(base + offset * 86400000)
    const parts = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate(),
      weekday: d.getUTCDay() === 0 ? 7 : d.getUTCDay()
    }

    const week = tt.weekOf(term, parts)
    if (!week) continue

    let best = null
    for (let i = 0; i < courses.length; i++) {
      const c = courses[i]
      if (!c || c.day !== parts.weekday) continue
      if (!tt.isActiveInWeek(c, week)) continue
      if (sections && sections.indexOf(Number(c.start)) === -1) continue

      const start = tt.sectionStart(c.start)
      if (isNaN(start)) continue
      // 今天已经开始的课不算「下一节」
      if (offset === 0 && start <= nowParts.minutes) continue

      if (!best || start < best.start) {
        best = { course: c, start: start, parts: parts, offset: offset }
      }
    }
    if (best) return best
  }

  return null
}

/** 测试消息里的「距离开始时间」：按真实剩余时长显示，别把两天后说成 20 分钟 */
function countdownTextOf(minutesUntil) {
  const m = Math.max(1, Math.round(minutesUntil))
  if (m < 60) return m + '分钟'
  if (m < 1440) return Math.round(m / 60) + '小时'
  return Math.floor(m / 1440) + '天'
}

/**
 * 立刻给当前用户发一条测试提醒。不扣额度、不改开关。
 * 开发者工具 Console：
 *   wx.cloud.callFunction({ name: 'reminder', data: { action: 'sendTest' } })
 * 没有提醒记录时可以补 studentId，用课表里的课做内容。
 */
async function sendTest(openid, data) {
  if (!openid) return { ok: false, reason: 'no-identity' }
  if (!config.TEMPLATE_ID) return { ok: false, reason: 'no-template' }

  const doc = await getReminder(openid)
  const studentId = (doc && doc.studentId) || String(data.studentId || '').trim()
  const lead = normalizeLead(doc && doc.leadMinutes)

  const schedule = studentId ? await getSchedule(studentId) : null
  const courses = schedule && Array.isArray(schedule.courses) ? schedule.courses : []
  const nameText = cleanName(doc && doc.name) || cleanName(schedule && schedule.profile && schedule.profile.name)
  const t = tt.beijingParts(new Date())

  // 用「最近一次真实会上的课」，日期也用它真正的那天
  const found = schedule ? nextCourseOccurrence(courses, schedule.term || {}, t, config.BLOCK_START_SECTIONS) : null

  let course
  let start
  let when
  let countdown

  if (found) {
    course = found.course
    start = found.start
    when = found.parts
    countdown = countdownTextOf(found.offset * 1440 + found.start - t.minutes)
  } else {
    course = { name: '测试课程', room: '教学楼', teacher: '测试' }
    start = Math.min(t.minutes + lead, 23 * 60 + 59)
    when = { year: t.year, month: t.month, day: t.day, weekday: t.weekday }
    countdown = lead + '分钟'
  }

  try {
    await sendMessage(openid, course, start, when, lead, countdown)
    console.log('[reminder] 测试发送 ' + whoOf({ studentId: studentId, name: nameText }) +
      ' 课程=' + course.name + ' 上课=' + timeValue(start, when))
    await writeLog({ type: 'action', action: 'sendTest', studentId: studentId,
      name: nameText, course: course.name })
    return {
      ok: true,
      sent: true,
      note: '测试消息已发送，不扣剩余次数；没收到先看微信「服务通知」有没有被关掉',
      course: course.name,
      date: when.year + '-' + pad2(when.month + 1) + '-' + pad2(when.day) + ' ' + (WEEKDAY_NAMES[when.weekday] || ''),
      time: timeValue(start, when),
      countdown: countdown
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'send-failed',
      code: errCode(err),
      message: errMsg(err)
    }
  }
}

/**
 * 用和定时器完全相同的逻辑，跑一次当前用户的提醒。
 * 必须从小程序端调用（才有云调用票据）；云开发控制台调用仍然会 -501007。
 * 会真实发送、扣额度、可能触发自动关闭 —— 行为和线上一致。
 */
async function testReminder(openid, data) {
  if (!openid) return { ok: false, reason: 'no-identity' }

  const doc = await getReminder(openid)
  if (!doc) return { ok: false, reason: 'no-reminder' }

  const now = data.__now ? new Date(data.__now) : new Date()
  if (isNaN(now.getTime())) return { ok: false, reason: 'bad-now' }

  const t = tt.beijingParts(now)
  const result = await remindUser(doc, t)

  await writeLog({ type: 'action', action: 'testReminder',
    studentId: doc.studentId || '', name: doc.name || '',
    time: describeNow(t), result: result.trace || '' })

  return {
    ok: true,
    now: describeNow(t),
    sent: result.sent,
    failed: result.failed,
    trace: result.trace || ''
  }
}

/* ───────────────────────── 定时触发 ───────────────────────── */

async function onTimer(event) {
  const now = event.__now ? new Date(event.__now) : new Date()
  if (isNaN(now.getTime())) return { ok: false, reason: 'bad-now' }
  if (!config.TEMPLATE_ID) return { ok: false, reason: 'no-template' }

  const t = tt.beijingParts(now)

  // 廉价早退：绝大多数分钟直接在这里返回，不碰数据库。
  // 每个用户可能选不同的提前量，所以按允许值的全集来判断
  if (!tt.isReminderMinute(t.minutes, config.ALLOWED_LEAD_MINUTES, config.BLOCK_START_SECTIONS)) {
    return { ok: true, skipped: 'minute' }
  }

  const users = await readEnabled()
  let sent = 0
  let failed = 0
  // 逐人明细：控制台测试时能看出扫到了谁、每个人为什么没发
  const details = []

  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    const base = {
      studentId: u.studentId || '',
      openidTail: String(u.openid || u._id || '').slice(-6)
    }

    try {
      const r = await remindUser(u, t)
      sent += r.sent
      failed += r.failed
      details.push(Object.assign(base, { action: r.trace || '未发送' }))
    } catch (err) {
      failed++
      details.push(Object.assign(base, { action: '处理出错：' + errMsg(err) }))
      console.error('[reminder] 用户处理失败 ' + whoOf(u) + '：' + errMsg(err))
    }
  }

  // 这一轮的逐人结果落库，之后在数据库里就能回看
  if (users.length) {
    await writeLog({
      type: 'scan',
      time: t.dateKey + ' ' + hhmm(t.minutes),
      dateKey: t.dateKey,
      minutes: t.minutes,
      users: users.length,
      sent: sent,
      failed: failed,
      details: details
    })
  }

  console.log('[reminder] 扫描 ' + t.dateKey + ' ' + hhmm(t.minutes) +
    ' 用户=' + users.length + ' 发送=' + sent + ' 失败=' + failed)

  return {
    ok: true,
    users: users.length,
    sent: sent,
    failed: failed,
    details: details.slice(0, 50)
  }
}

/** 给一个用户发这一分钟该发的提醒；返回本次发送条数 */
async function remindUser(doc, t) {
  const schedule = await getSchedule(doc.studentId)
  if (!schedule || !Array.isArray(schedule.courses)) {
    return { sent: 0, failed: 0, trace: '云端没有课表备份' }
  }

  const week = tt.weekOf(schedule.term || {}, t)
  if (!week) {
    return { sent: 0, failed: 0, trace: '今天不在学期周次内（检查开学周一）' }
  }

  // 每个用户可以在小程序里自己设「课前几分钟」
  const lead = normalizeLead(doc.leadMinutes)
  const nameText = cleanName(doc.name) || cleanName(schedule.profile && schedule.profile.name) || '-'
  const who = '学号=' + (doc.studentId || '-') + ' 姓名=' + nameText

  const matches = tt.matchCourses(schedule.courses, {
    weekday: t.weekday,
    week: week,
    minutes: t.minutes
  }, lead, config.BLOCK_START_SECTIONS)

  if (!matches.length) {
    const todays = schedule.courses.filter(function (c) {
      return c && c.day === t.weekday && tt.isActiveInWeek(c, week)
    })
    return {
      sent: 0,
      failed: 0,
      trace: todays.length
        ? '今天有 ' + todays.length + ' 节课，但当前分钟不是提醒时刻'
        : '今天没有课'
    }
  }

  // 同一天已经发过的（日期#课程id）不再发 —— 定时器延迟重跑也不会重复
  const sameDay = doc.lastSentDate === t.dateKey
  const sentKeys = sameDay && Array.isArray(doc.sentKeys) ? doc.sentKeys.slice() : []
  let quota = Number(doc.quota) || 0
  let needSubscribe = !!doc.needSubscribe
  let noSubscription = false // 43101：微信侧已经没有可用订阅，额度必须清零
  let sent = 0
  let failed = 0
  let lastError = 0
  let lastErrorMsg = ''
  const sentNames = []

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
      sentNames.push(item.course.name)
      sentKeys.push(key)
      if (config.MODE === 'once') quota = Math.max(0, quota - 1)
      console.log('[reminder] 发送 ' + who + ' 课程=' + item.course.name +
        ' 上课=' + hhmm(item.start))
    } catch (err) {
      failed++
      const code = errCode(err)
      lastError = code
      lastErrorMsg = clip(errMsg(err), 60)
      console.error('[reminder] 发送失败 ' + who + ' 课程=' + item.course.name +
        ' 错误码=' + code + ' ' + errMsg(err))
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

  let trace
  if (sent > 0) {
    trace = '已发送：' + sentNames.join('、')
    if (noSubscription) trace += '（微信无可用订阅，提醒已自动关闭）'
    else if (quota <= 0) trace += '（次数已用完，提醒已自动关闭）'
  } else if (noSubscription) {
    trace = '微信无可用订阅（43101），提醒已自动关闭'
  } else if (quota <= 0) {
    trace = '额度为 0，未发送'
  } else if (failed > 0) {
    trace = '发送失败（错误码 ' + lastError + (lastErrorMsg ? '：' + lastErrorMsg : '') + '）'
  } else {
    trace = '今天这节课已经发过'
  }

  return { sent: sent, failed: failed, trace: trace }
}

/* ── access_token 兜底通道 ──
 * cloud.openapi 用的是微信内部票据；定时触发器不是在微信开发者工具里创建的时候，
 * 票据是空的，发送会报 -501007 Invalid wxCloudApiToken。
 * 这里用网页 API 直连：AppID + AppSecret 换 access_token 再发，不依赖票据。
 * 只在主通道报 -501007 / -501001 时才走，正常情况不会多花一次请求。
 */

let tokenCache = { value: '', expireAt: 0 }

function httpJson(method, url, bodyObj) {
  return new Promise(function (resolve, reject) {
    const payload = bodyObj ? JSON.stringify(bodyObj) : ''
    const headers = { 'Content-Type': 'application/json' }
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload)

    const req = https.request(url, { method: method, headers: headers, timeout: 8000 }, function (res) {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', function (chunk) { raw += chunk })
      res.on('end', function () {
        try {
          resolve(JSON.parse(raw))
        } catch (e) {
          reject(new Error('响应不是 JSON：' + raw.slice(0, 200)))
        }
      })
    })
    req.on('timeout', function () { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function appSecret() {
  return String(process.env[config.APPSECRET_ENV] || '').trim()
}

async function accessToken() {
  const secret = appSecret()
  if (!config.APPID) throw new Error('config.APPID 未配置')
  if (!secret) throw new Error('环境变量 ' + config.APPSECRET_ENV + ' 未配置')

  const now = Date.now()
  // 留一分钟余量，避免刚好在过期点上用掉
  if (tokenCache.value && tokenCache.expireAt > now + 60000) return tokenCache.value

  const res = await httpJson('GET',
    'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential' +
    '&appid=' + encodeURIComponent(config.APPID) +
    '&secret=' + encodeURIComponent(secret))

  if (!res.access_token) {
    throw new Error('换 access_token 失败：' + (res.errcode || '') + ' ' + (res.errmsg || ''))
  }
  tokenCache = {
    value: res.access_token,
    expireAt: now + (Number(res.expires_in) || 7200) * 1000
  }
  return tokenCache.value
}

async function sendViaHttp(openid, data) {
  const token = await accessToken()
  const res = await httpJson('POST',
    'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(token),
    {
      touser: openid,
      template_id: config.TEMPLATE_ID,
      page: config.PAGE,
      miniprogram_state: config.MINIPROGRAM_STATE,
      lang: 'zh_CN',
      data: data
    })

  if (Number(res.errcode) !== 0) {
    const err = new Error('发送失败 ' + res.errcode + ' ' + (res.errmsg || ''))
    err.errCode = Number(res.errcode)
    throw err
  }
  return res
}

/** 主通道返回的是「没有票据」这一类错误吗 */
function isNoTokenError(err) {
  const code = errCode(err)
  if (code === -501007 || code === -501001) return true
  return errMsg(err).indexOf('wxCloudApiToken') > -1
}

async function probeToken() {
  return {
    ok: true,
    appid: config.APPID || '',
    secretEnv: config.APPSECRET_ENV,
    secretSet: !!appSecret(),
    token: await accessToken().then(function (v) { return 'ok：' + String(v).slice(0, 8) + '…' })
      .catch(function (e) { return 'fail：' + errMsg(e) })
  }
}

async function sendMessage(openid, course, startMinutes, t, leadMinutes, countdownText) {
  if (!openid) throw new Error('缺少 openid')

  // 正常提醒用「还有 N 分钟上课」；测试消息可以传真实剩余时长
  const tip = countdownText || String(config.TIP_TEXT || '').replace('{lead}', String(leadMinutes))
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

  try {
    return await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: config.TEMPLATE_ID,
      page: config.PAGE,
      data: data,
      miniprogramState: config.MINIPROGRAM_STATE,
      lang: 'zh_CN'
    })
  } catch (err) {
    if (!isNoTokenError(err)) throw err

    // 没有票据：换 access_token 直连再发一次
    try {
      const res = await sendViaHttp(openid, data)
      console.log('[reminder] 云调用无票据，access_token 兜底发送成功 ' + (t ? t.dateKey : ''))
      return res
    } catch (err2) {
      const e = new Error('云调用无票据（' + errMsg(err) + '），兜底也失败：' + errMsg(err2))
      e.errCode = errCode(err2) || errCode(err)
      throw e
    }
  }
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

function cleanName(value) {
  return String(value || '').trim().slice(0, 20)
}

/**
 * 重要行为落一份到数据库（reminder_logs）。
 * 控制台日志需要付费会员，数据库在控制台随时可查；写入失败不影响提醒本身。
 */
async function writeLog(entry) {
  try {
    await db.collection(config.COLLECTIONS.logs).add({
      data: Object.assign({ at: Date.now() }, entry)
    })
  } catch (err) {
    // 集合没建 / 权限不对都忽略
  }
}

/** 日志里统一带上「学号 + 姓名」 */
function whoOf(doc) {
  return '学号=' + ((doc && doc.studentId) || '-') + ' 姓名=' + ((doc && doc.name) || '-')
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value))
  if (!isFinite(n) || n < min) return 0
  return Math.min(n, max)
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 时间戳 → 北京时间「MM-DD HH:MM」，只给诊断输出用 */
function formatAt(ts) {
  const n = Number(ts) || 0
  if (!n) return ''
  const p = tt.beijingParts(new Date(n))
  return (p.month + 1) + '-' + pad2(p.day) + ' ' +
    pad2(Math.floor(p.minutes / 60)) + ':' + pad2(p.minutes % 60)
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
