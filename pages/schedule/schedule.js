// pages/schedule/schedule.js

/** 每节课的行高（rpx），与 wxss 里的 .slot 高度保持一致 */
const ROW_H = 112
/** 学期总周数 */
const TOTAL_WEEKS = 20
/** 学期第 1 周所在周的周一，用来推算每周的日期 */
const SEMESTER_START = new Date(2026, 7, 31)
/** 星期表头，index 0 = 周一 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 节次时间表 */
const SECTIONS = [
  { i: 1, from: '08:00', to: '08:45' },
  { i: 2, from: '08:55', to: '09:40' },
  { i: 3, from: '10:00', to: '10:45' },
  { i: 4, from: '10:55', to: '11:40' },
  { i: 5, from: '14:00', to: '14:45' },
  { i: 6, from: '14:55', to: '15:40' },
  { i: 7, from: '16:00', to: '16:45' },
  { i: 8, from: '16:55', to: '17:40' },
  { i: 9, from: '19:00', to: '19:45' },
  { i: 10, from: '19:55', to: '20:40' }
]

/** 课程块配色，循环取用 */
const PALETTE = [
  { bg: '#E6F7F1', border: '#0FA97E', text: '#0A6B50' },
  { bg: '#E8F1FE', border: '#4A90E2', text: '#1E4FA8' },
  { bg: '#FFF3E4', border: '#F0A93B', text: '#9A5B0A' },
  { bg: '#F1EDFE', border: '#8B7CF6', text: '#5842B8' },
  { bg: '#FDECF1', border: '#EE7BA8', text: '#A63064' }
]

/**
 * 课程数据（静态）。
 * day: 1-7 代表周一到周日；start: 起始节次；span: 连续节数
 * weeks: [起始周, 结束周]；parity: 'odd' 单周 / 'even' 双周 / 不填为每周
 */
const COURSES = [
  { id: 'c01', name: '高等数学 A', teacher: '张明', room: '三教 201', day: 1, start: 1, span: 2, weeks: [1, 16], color: 0 },
  { id: 'c02', name: '微观经济学', teacher: '李慧', room: '五教 108', day: 1, start: 3, span: 2, weeks: [1, 16], color: 1 },
  { id: 'c03', name: '会计学原理', teacher: '王建国', room: '二教 305', day: 1, start: 7, span: 2, weeks: [1, 16], color: 2 },

  { id: 'c04', name: '大学英语（三）', teacher: 'Sarah', room: '外语楼 402', day: 2, start: 1, span: 2, weeks: [1, 16], color: 3 },
  { id: 'c05', name: '统计学', teacher: '陈涛', room: '五教 210', day: 2, start: 5, span: 2, weeks: [1, 16], color: 4 },

  { id: 'c06', name: '线性代数', teacher: '刘芳', room: '三教 108', day: 3, start: 3, span: 2, weeks: [1, 16], color: 1 },
  { id: 'c07', name: '计算机应用基础', teacher: '赵鑫', room: '实验楼 305', day: 3, start: 7, span: 2, weeks: [2, 17], color: 0 },

  { id: 'c08', name: '管理学原理', teacher: '孙丽', room: '五教 302', day: 4, start: 1, span: 2, weeks: [1, 16], color: 2 },
  { id: 'c09', name: '财务管理', teacher: '周彦', room: '二教 401', day: 4, start: 5, span: 2, weeks: [1, 16], color: 0 },

  { id: 'c10', name: '金融学', teacher: '吴敏', room: '五教 106', day: 5, start: 3, span: 2, weeks: [1, 16], color: 3 },
  { id: 'c11', name: '形势与政策', teacher: '郑华', room: '一教报告厅', day: 5, start: 7, span: 2, weeks: [1, 17], parity: 'odd', color: 4 },

  { id: 'c12', name: '体育（羽毛球）', teacher: '黄磊', room: '体育馆', day: 6, start: 3, span: 2, weeks: [1, 16], color: 1 }
]

/** 取某天所在周的周一，清零时分秒 */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = d.getDay() === 0 ? 7 : d.getDay() // 周日算作 7
  d.setDate(d.getDate() - (weekday - 1))
  return d
}

/** 用于比较是否为同一天 */
function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** 今天属于第几周，超出范围时收敛到 [1, TOTAL_WEEKS] */
function currentWeek() {
  const start = mondayOf(SEMESTER_START)
  const now = mondayOf(new Date())
  const diff = Math.round((now - start) / (7 * 24 * 60 * 60 * 1000)) + 1
  return Math.min(Math.max(diff, 1), TOTAL_WEEKS)
}

/** 判断课程在第 n 周是否上课 */
function isActiveInWeek(course, week) {
  const from = course.weeks[0]
  const to = course.weeks[1]
  if (week < from || week > to) return false
  if (course.parity === 'odd') return week % 2 === 1
  if (course.parity === 'even') return week % 2 === 0
  return true
}

/** 「第 1-17 周（单周）」这样的文案 */
function weekTextOf(course) {
  let text = `第 ${course.weeks[0]}-${course.weeks[1]} 周`
  if (course.parity === 'odd') text += '（单周）'
  if (course.parity === 'even') text += '（双周）'
  return text
}

/** 构建某一周的 7 天数据，含课程块的位置和配色 */
function buildWeek(week) {
  const monday = mondayOf(SEMESTER_START)
  monday.setDate(monday.getDate() + (week - 1) * 7)

  const todayKey = dateKey(new Date())
  const days = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 24 * 60 * 60 * 1000)
    days.push({
      day: i + 1,
      label: WEEK_LABELS[i],
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: dateKey(d) === todayKey,
      courses: []
    })
  }

  COURSES.forEach(course => {
    if (!isActiveInWeek(course, week)) return
    const target = days[course.day - 1]
    if (!target) return

    const palette = PALETTE[course.color % PALETTE.length]
    const first = SECTIONS[course.start - 1]
    const last = SECTIONS[course.start + course.span - 2]

    target.courses.push({
      id: course.id,
      name: course.name,
      room: course.room,
      teacher: course.teacher,
      text: palette.text,
      timeText: `${first.from} - ${last.to}`,
      weekText: weekTextOf(course),
      // 绝对定位：起始节次决定 top，节数决定 height
      style: [
        `top:${(course.start - 1) * ROW_H}rpx`,
        `height:${course.span * ROW_H - 10}rpx`,
        `background:${palette.bg}`,
        `border-left-color:${palette.border}`,
        `color:${palette.text}`
      ].join(';')
    })
  })

  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000)
  const rangeText =
    monday.getMonth() === sunday.getMonth()
      ? `${monday.getMonth() + 1} 月 ${monday.getDate()} - ${sunday.getDate()} 日`
      : `${monday.getMonth() + 1} 月 ${monday.getDate()} 日 - ${sunday.getMonth() + 1} 月 ${sunday.getDate()} 日`

  const weekCourseCount = days.reduce((sum, d) => sum + d.courses.length, 0)

  return { days, rangeText, weekCourseCount }
}

Page({
  data: {
    rowH: ROW_H,
    sections: SECTIONS,
    days: [],
    week: 1,
    thisWeek: 1,
    weekRangeText: '',
    weekCourseCount: 0,
    showDetail: false,
    detail: null
  },

  onLoad() {
    const thisWeek = currentWeek()
    this.setData({ thisWeek })
    this.renderWeek(thisWeek)
  },

  onShow() {
    // 自定义 tabBar 需要每个 tab 页自行同步选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
  },

  renderWeek(week) {
    const { days, rangeText, weekCourseCount } = buildWeek(week)
    this.setData({
      week,
      days,
      weekRangeText: rangeText,
      weekCourseCount
    })
  },

  onPrevWeek() {
    if (this.data.week <= 1) {
      wx.showToast({ title: '已经是第 1 周', icon: 'none' })
      return
    }
    this.renderWeek(this.data.week - 1)
  },

  onNextWeek() {
    if (this.data.week >= TOTAL_WEEKS) {
      wx.showToast({ title: `已经是第 ${TOTAL_WEEKS} 周`, icon: 'none' })
      return
    }
    this.renderWeek(this.data.week + 1)
  },

  /** 点击中间的周次区域，跳回本周 */
  onToday() {
    if (this.data.week === this.data.thisWeek) {
      wx.showToast({ title: '当前就是本周', icon: 'none' })
      return
    }
    this.renderWeek(this.data.thisWeek)
    wx.showToast({ title: `已回到第 ${this.data.thisWeek} 周`, icon: 'none' })
  },

  onCourseTap(e) {
    const id = e.currentTarget.dataset.id
    let hit = null
    this.data.days.some(day => {
      const found = day.courses.find(c => c.id === id)
      if (found) {
        hit = found
        return true
      }
      return false
    })
    if (!hit) return
    this.setData({ detail: hit, showDetail: true })
  },

  onCloseDetail() {
    this.setData({ showDetail: false })
  },

  /** 阻止蒙层下的页面跟着滚动 */
  noop() {}
})
