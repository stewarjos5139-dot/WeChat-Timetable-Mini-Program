// utils/store.js
/**
 * 课表数据的本地存储。
 *
 * 刻意不保存密码 —— 只记学号方便下次填写。密码每次导入时由用户现输，
 * 用完即弃，不落盘。
 */

const KEY_COURSES = 'schedule_courses'
const KEY_TERM = 'schedule_term'
const KEY_STAMP = 'schedule_stamp'
const KEY_PROFILE = 'user_profile'
// 旧版只存学号的 key。现在只读不写，给装过旧版本的机器做回退（见 getAccount）
const KEY_ACCOUNT = 'schedule_account'

/** 学期设置默认值。xnm/xqm 是正方教务系统的学年/学期参数 */
const DEFAULT_TERM = {
  xnm: '2026', // 学年起始年份，2026 表示 2026-2027 学年
  xqm: '3', // 3 = 第一学期，12 = 第二学期，16 = 第三学期
  totalWeeks: 20, // 学期总周数
  // 第 1 周周一。课表页靠它算「今天是第几周」和周次表头的日期，
  // 填错会让整张表的周次和日期整体偏移。所以登录页让用户自己选，不写死。
  startDate: '2026-08-31'
}

/** 正方 xqm 参数的可选值 */
const TERM_OPTIONS = [
  { label: '第一学期', value: '3' },
  { label: '第二学期', value: '12' },
  { label: '第三学期', value: '16' }
]

/** 生成最近几年的学年选项，最新的排最前 */
function buildYearOptions() {
  const thisYear = new Date().getFullYear()
  const list = []
  for (let i = 0; i < 5; i++) {
    const start = thisYear - i
    list.push({ label: `${start}-${start + 1} 学年`, value: String(start) })
  }
  return list
}

function getCourses() {
  const list = wx.getStorageSync(KEY_COURSES)
  return Array.isArray(list) ? list : []
}

/**
 * 保存课表。同时刷新时间戳，课表页靠它判断数据有没有变，
 * 避免每次 onShow 都重建整周数据（那会把用户翻到的周次弹回去）。
 */
function setCourses(list) {
  wx.setStorageSync(KEY_COURSES, Array.isArray(list) ? list : [])
  wx.setStorageSync(KEY_STAMP, Date.now())
}

function clearCourses() {
  wx.removeStorageSync(KEY_COURSES)
  wx.setStorageSync(KEY_STAMP, Date.now())
}

/** 数据版本号，读写课表时都会变 */
function getStamp() {
  return wx.getStorageSync(KEY_STAMP) || 0
}

function getTerm() {
  const saved = wx.getStorageSync(KEY_TERM)
  return Object.assign({}, DEFAULT_TERM, saved && typeof saved === 'object' ? saved : {})
}

function setTerm(term) {
  wx.setStorageSync(KEY_TERM, Object.assign({}, DEFAULT_TERM, term || {}))
}

/* ─────────────── 用户档案 ───────────────
 * 导入课表时顺带从教务系统拿到姓名，和学号一起存下来。
 * 档案独立于课表 —— 清除课表数据不会动它。
 */

/** 档案 { studentId, name }；从没导入过时返回 null */
function getProfile() {
  const saved = wx.getStorageSync(KEY_PROFILE)
  return saved && typeof saved === 'object' && saved.studentId ? saved : null
}

function setProfile(profile) {
  const p = profile || {}
  wx.setStorageSync(KEY_PROFILE, {
    studentId: String(p.studentId || '').trim(),
    name: String(p.name || '').trim()
  })
}

/**
 * 登录表单里预填的学号。
 * 优先读档案；档案不存在时回退到旧版的 KEY_ACCOUNT ——
 * 装过旧版本的机器升级后，学号不会丢。
 */
function getAccount() {
  const profile = getProfile()
  if (profile) return profile.studentId
  return wx.getStorageSync(KEY_ACCOUNT) || ''
}

module.exports = {
  DEFAULT_TERM,
  TERM_OPTIONS,
  buildYearOptions,
  getCourses,
  setCourses,
  clearCourses,
  getStamp,
  getTerm,
  setTerm,
  getProfile,
  setProfile,
  getAccount
}
