// pages/schedule/schedule.js
const store = require('../../utils/store')

/** 每节课的行高（rpx），与 wxss 里的 .slot 高度保持一致 */
const ROW_H = 112
/** 星期表头，index 0 = 周一 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 节次结构。学校一天 13 节：上午 1-5、下午 6-10、晚上 11-13。
 *
 * 起止时间（from / to）暂时空着 —— 补上之后，左侧节次栏和课程详情会自动
 * 从「第 11-12 节」切换成时间区间显示，不用改别的代码。
 */
const SECTION_COUNT = 13

const SECTIONS = (function () {
  const list = []
  for (let i = 1; i <= SECTION_COUNT; i++) {
    list.push({
      i: i,
      period: i <= 5 ? 'morning' : i <= 10 ? 'afternoon' : 'evening'
    })
  }
  return list
})()

/** 课程块配色，循环取用。长度要与 utils/parser.js 的 COLOR_COUNT 一致 */
const PALETTE = [
  { bg: '#E6F7F1', border: '#0FA97E', text: '#0A6B50' },
  { bg: '#E8F1FE', border: '#4A90E2', text: '#1E4FA8' },
  { bg: '#FFF3E4', border: '#F0A93B', text: '#9A5B0A' },
  { bg: '#F1EDFE', border: '#8B7CF6', text: '#5842B8' },
  { bg: '#FDECF1', border: '#EE7BA8', text: '#A63064' }
]

/** 还没导入真实课表时展示的示例数据 */
const DEMO_COURSES = [
  { id: 'demo01', name: '高等数学 A', teacher: '张明', room: '三教 201', day: 1, start: 1, span: 2, weeks: [1, 16], color: 0 },
  { id: 'demo02', name: '微观经济学', teacher: '李慧', room: '五教 108', day: 1, start: 3, span: 2, weeks: [1, 16], color: 1 },
  { id: 'demo03', name: '会计学原理', teacher: '王建国', room: '二教 305', day: 1, start: 7, span: 2, weeks: [1, 16], color: 2 },
  { id: 'demo04', name: '大学英语（三）', teacher: 'Sarah', room: '外语楼 402', day: 2, start: 1, span: 2, weeks: [1, 16], color: 3 },
  { id: 'demo05', name: '统计学', teacher: '陈涛', room: '五教 210', day: 2, start: 5, span: 2, weeks: [1, 16], color: 4 },
  { id: 'demo06', name: '线性代数', teacher: '刘芳', room: '三教 108', day: 3, start: 3, span: 2, weeks: [1, 16], color: 1 },
  { id: 'demo07', name: '计算机应用基础', teacher: '赵鑫', room: '实验楼 305', day: 3, start: 7, span: 2, weeks: [2, 17], color: 0 },
  { id: 'demo08', name: '管理学原理', teacher: '孙丽', room: '五教 302', day: 4, start: 1, span: 2, weeks: [1, 16], color: 2 },
  { id: 'demo09', name: '财务管理', teacher: '周彦', room: '二教 401', day: 4, start: 5, span: 2, weeks: [1, 16], color: 0 },
  { id: 'demo10', name: '金融学', teacher: '吴敏', room: '五教 106', day: 5, start: 3, span: 2, weeks: [1, 16], color: 3 },
  { id: 'demo11', name: '形势与政策', teacher: '郑华', room: '一教报告厅', day: 5, start: 7, span: 2, weeks: [1, 17], parity: 'odd', color: 4 },
  { id: 'demo12', name: '体育（羽毛球）', teacher: '黄磊', room: '体育馆', day: 6, start: 3, span: 2, weeks: [1, 16], color: 1 }
]

/** 'YYYY-MM-DD' → Date，格式不对时退回今天 */
function parseDate(str) {
  const parts = String(str || '').split('-')
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const d = parseInt(parts[2], 10)
  if (!y || !m || !d) return new Date()
  return new Date(y, m - 1, d)
}

/** 取某天所在周的周一，清零时分秒 */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const weekday = d.getDay() === 0 ? 7 : d.getDay() // 周日算作 7
  d.setDate(d.getDate() - (weekday - 1))
  return d
}

/** 用于比较是否为同一天 */
function dateKey(date) {
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate()
}

/** 今天属于第几周，超出范围时收敛到 [1, totalWeeks] */
function currentWeek(startDate, totalWeeks) {
  const start = mondayOf(startDate)
  const now = mondayOf(new Date())
  const diff = Math.round((now - start) / (7 * 24 * 60 * 60 * 1000)) + 1
  return Math.min(Math.max(diff, 1), totalWeeks)
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
  let text = '第 ' + course.weeks[0] + '-' + course.weeks[1] + ' 周'
  if (course.parity === 'odd') text += '（单周）'
  if (course.parity === 'even') text += '（双周）'
  return text
}

/** 「2026-2027 学年 · 第一学期」 */
function termLabel(term) {
  const startYear = parseInt(term.xnm, 10)
  let termName = '第一学期'
  store.TERM_OPTIONS.forEach(function (option) {
    if (option.value === term.xqm) termName = option.label
  })
  return startYear + '-' + (startYear + 1) + ' 学年 · ' + termName
}

/** 构建某一周的 7 天数据，含课程块的位置和配色 */
function buildWeek(week, courses, term, totalWeeks) {
  const monday = mondayOf(parseDate(term.startDate))
  monday.setDate(monday.getDate() + (week - 1) * 7)

  const todayKey = dateKey(new Date())
  const days = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 24 * 60 * 60 * 1000)
    days.push({
      day: i + 1,
      label: WEEK_LABELS[i],
      date: (d.getMonth() + 1) + '/' + d.getDate(),
      isToday: dateKey(d) === todayKey,
      courses: []
    })
  }

  courses.forEach(function (course) {
    if (!course.weeks) return
    if (!isActiveInWeek(course, week)) return

    const target = days[course.day - 1]
    if (!target) return

    // color 缺失时退回 0，避免旧格式数据把 PALETTE[NaN] 取成 undefined
    const palette = PALETTE[(course.color || 0) % PALETTE.length]
    const first = SECTIONS[course.start - 1]
    const last = SECTIONS[course.start + course.span - 2]
    if (!first || !last) return // 节次超出时间表范围，跳过而不是崩掉

    // 起止时间还没录入时，退回「第 x-y 节」的写法
    const lastSection = course.start + course.span - 1
    const timeText = (first.from && last.to)
      ? first.from + ' - ' + last.to
      : '第 ' + course.start + '-' + lastSection + ' 节'

    target.courses.push({
      id: course.id,
      name: course.name,
      room: course.room,
      teacher: course.teacher,
      text: palette.text,
      timeText: timeText,
      weekText: weekTextOf(course),
      // 绝对定位：起始节次决定 top，节数决定 height
      style: [
        'top:' + ((course.start - 1) * ROW_H) + 'rpx',
        'height:' + (course.span * ROW_H - 10) + 'rpx',
        'background:' + palette.bg,
        'border-left-color:' + palette.border,
        'color:' + palette.text
      ].join(';')
    })
  })

  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000)
  const rangeText =
    monday.getMonth() === sunday.getMonth()
      ? (monday.getMonth() + 1) + ' 月 ' + monday.getDate() + ' - ' + sunday.getDate() + ' 日'
      : (monday.getMonth() + 1) + ' 月 ' + monday.getDate() + ' 日 - ' +
        (sunday.getMonth() + 1) + ' 月 ' + sunday.getDate() + ' 日'

  const weekCourseCount = days.reduce(function (sum, d) { return sum + d.courses.length }, 0)

  return { days: days, rangeText: rangeText, weekCourseCount: weekCourseCount }
}

Page({
  data: {
    rowH: ROW_H,
    sections: SECTIONS,
    days: [],
    week: 1,
    thisWeek: 1,
    totalWeeks: 20,
    weekRangeText: '',
    weekCourseCount: 0,
    isDemo: false,
    termText: '',
    showDetail: false,
    detail: null
  },

  onLoad() {
    this._stamp = store.getStamp()
    this.loadData()
  },

  onShow() {
    // 自定义 tabBar 需要每个 tab 页自行同步选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }

    // 从导入页返回时课表可能变了，重建一次；没变就不动，免得把翻到的周次弹回去
    const stamp = store.getStamp()
    if (stamp !== this._stamp) {
      this._stamp = stamp
      this.loadData()
    }
  },

  /** 从本地存储装配课表；没有真实数据时退回示例数据 */
  loadData() {
    const stored = store.getCourses()
    const term = store.getTerm()
    const totalWeeks = term.totalWeeks || 20
    const isDemo = stored.length === 0

    this._courses = isDemo ? DEMO_COURSES : stored
    this._term = term
    this._totalWeeks = totalWeeks
    this._thisWeek = currentWeek(parseDate(term.startDate), totalWeeks)

    this.setData({
      isDemo: isDemo,
      totalWeeks: totalWeeks,
      thisWeek: this._thisWeek,
      termText: termLabel(term)
    })

    this.renderWeek(this._thisWeek)
  },

  renderWeek(week) {
    const result = buildWeek(week, this._courses, this._term, this._totalWeeks)
    this.setData({
      week: week,
      days: result.days,
      weekRangeText: result.rangeText,
      weekCourseCount: result.weekCourseCount
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
    if (this.data.week >= this._totalWeeks) {
      wx.showToast({ title: '已经是第 ' + this._totalWeeks + ' 周', icon: 'none' })
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
    wx.showToast({ title: '已回到第 ' + this.data.thisWeek + ' 周', icon: 'none' })
  },

  onImport() {
    wx.navigateTo({ url: '../login/login' })
  },

  onCourseTap(e) {
    const id = e.currentTarget.dataset.id
    let hit = null
    this.data.days.some(function (day) {
      const found = day.courses.filter(function (c) { return c.id === id })[0]
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
