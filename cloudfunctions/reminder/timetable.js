/**
 * 上课提醒的课表计算。
 *
 * ⚠️ 这里的 SECTION_TIME、周次判断逻辑是 pages/schedule/schedule.js 的镜像 ——
 * 云函数部署时只会带上自己这个目录，没法 require 小程序端的文件。
 * 学校改上课时间、或课表周次规则变化时，两处要一起改：
 *   pages/schedule/schedule.js 的 SECTION_TIME / weekListOf / isActiveInWeek
 */

/** 每节课的上课 / 下课时间，按第 1 ~ 13 节排列，与小程序端保持一致 */
const SECTION_TIME = [
  ['08:00', '08:45'], // 1
  ['08:55', '09:40'], // 2
  ['09:55', '10:40'], // 3
  ['10:50', '11:35'], // 4
  ['11:45', '12:30'], // 5
  ['13:30', '14:15'], // 6
  ['14:25', '15:10'], // 7
  ['15:25', '16:10'], // 8
  ['16:20', '17:05'], // 9
  ['17:15', '18:00'], // 10
  ['19:00', '19:45'], // 11
  ['19:50', '20:35'], // 12
  ['20:40', '21:25']  // 13
]

/** 'HH:MM' → 当天第几分钟 */
function toMinutes(hhmm) {
  const parts = String(hhmm || '').split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (isNaN(h) || isNaN(m)) return NaN
  return h * 60 + m
}

/** 第 n 节的上课时刻（当天第几分钟），越界返回 NaN */
function sectionStart(n) {
  const t = SECTION_TIME[n - 1]
  return t ? toMinutes(t[0]) : NaN
}

/**
 * 所有课「上课时间 − 提前分钟数」的合集，去重后从小到大排好。
 * leads 可以传单个数字，也可以传数组（定时器早退时要把所有人的提前量合起来算）。
 */
function reminderMinutes(leads) {
  const list = Array.isArray(leads) ? leads : [leads]
  const set = {}
  SECTION_TIME.forEach(function (t) {
    const start = toMinutes(t[0])
    list.forEach(function (lead) {
      const m = start - lead
      if (m >= 0) set[m] = true
    })
  })
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b })
}

/**
 * 当前时刻是不是一个可能的提醒时刻。
 * 定时器有几百毫秒到一分钟的延迟，所以判断窗口取 [m-1, m]，
 * 真正的去重交给 sentKeys。
 */
function isReminderMinute(minutes, leads) {
  const list = reminderMinutes(leads)
  for (let i = 0; i < list.length; i++) {
    if (minutes === list[i] || minutes - 1 === list[i]) return true
  }
  return false
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * 把任意 Date 换算成北京时间的各个字段。
 * 全程走 UTC 取值，所以不受云函数运行环境时区影响。
 */
function beijingParts(date) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() // 0 起
  const day = shifted.getUTCDate()
  return {
    year: year,
    month: month,
    day: day,
    // 周日算作 7，和课表数据里的 day 对齐
    weekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dateKey: year + '-' + pad2(month + 1) + '-' + pad2(day)
  }
}

/** 'YYYY-MM-DD' → { y, m(0 起), d }，格式不对返回 null */
function parseDate(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(str || '').trim())
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) }
}

/** 从 1970-01-01 起的天数，用来做「差几天」的整数运算 */
function dayNumber(y, m, d) {
  return Math.floor(Date.UTC(y, m, d) / 86400000)
}

/**
 * 今天属于第几周。不在学期内（开学前 / 放假后）返回 0。
 * term.startDate 是第 1 周的周一。
 */
function weekOf(term, parts) {
  const start = parseDate(term && term.startDate)
  if (!start) return 0
  const total = Number(term.totalWeeks) || 20
  const diff = dayNumber(parts.year, parts.month, parts.day) - dayNumber(start.y, start.m, start.d)
  if (diff < 0) return 0
  const week = Math.floor(diff / 7) + 1
  return week > total ? 0 : week
}

/**
 * 课程在第 n 周是否上课。
 * 手动选过周的课存 weekList；导入的课是 weeks:[起, 止] + parity。
 */
function isActiveInWeek(course, week) {
  if (Array.isArray(course.weekList)) return course.weekList.indexOf(week) > -1
  if (!course.weeks || course.weeks.length < 2) return false
  const from = course.weeks[0]
  const to = course.weeks[1]
  if (week < from || week > to) return false
  if (course.parity === 'odd') return week % 2 === 1
  if (course.parity === 'even') return week % 2 === 0
  return true
}

/**
 * 找出「此刻该提醒」的课。
 * @param {Array} courses 课表
 * @param {Object} ctx { weekday, week, minutes }
 * @param {number} leadMinutes 提前几分钟
 * @returns {Array<{course:Object, start:number}>} start 是当天第几分钟
 */
function matchCourses(courses, ctx, leadMinutes) {
  const out = []
  if (!Array.isArray(courses) || !ctx.week) return out

  const reminders = reminderMinutes(leadMinutes)
  courses.forEach(function (course) {
    if (!course || course.day !== ctx.weekday) return
    if (!isActiveInWeek(course, ctx.week)) return
    if (!(course.start >= 1)) return

    const start = sectionStart(course.start)
    if (isNaN(start)) return

    const lead = start - leadMinutes
    if (lead < 0) return
    if (reminders.indexOf(lead) === -1) return
    // 定时器延迟容忍：提醒时刻是现在或上一分钟
    if (ctx.minutes !== lead && ctx.minutes - 1 !== lead) return

    out.push({ course: course, start: start })
  })
  return out
}

module.exports = {
  SECTION_TIME: SECTION_TIME,
  toMinutes: toMinutes,
  sectionStart: sectionStart,
  reminderMinutes: reminderMinutes,
  isReminderMinute: isReminderMinute,
  beijingParts: beijingParts,
  parseDate: parseDate,
  weekOf: weekOf,
  isActiveInWeek: isActiveInWeek,
  matchCourses: matchCourses
}
