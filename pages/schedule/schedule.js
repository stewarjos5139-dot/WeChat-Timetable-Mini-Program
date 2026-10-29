// pages/schedule/schedule.js
const config = require('../../utils/config')
const share = require('../../utils/share')
const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
const reminder = require('../../utils/reminder')

/** 每节课的行高（rpx），与 wxss 里的 .slot 高度保持一致 */
const ROW_H = 112

/**
 * 课表方块的字号档位（只影响块内文字）。模块加载时读一次放进初始 data，
 * 首次渲染就是用户选的字号，不会先按标准档闪一下再跳。
 */
const INITIAL_FONT_INDEX = store.getFontIndex()
const INITIAL_FONT_SCALE = store.FONT_LEVELS[INITIAL_FONT_INDEX].scale
/** 星期表头，index 0 = 周一 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/**
 * 每节课的上课 / 下课时间，按第 1 ~ 13 节排列。
 * 取自学校教务系统的「课程时间设置」，改时间改这儿就行。
 */
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

/**
 * 节次结构。学校一天 13 节：上午 1-5、下午 6-10、晚上 11-13。
 * from / to 填上之后，左侧节次栏和课程详情会自动从「第 11-12 节」切换成
 * 时间区间显示（见 timeTextOf）。
 */
const SECTION_COUNT = 13

const SECTIONS = (function () {
  const list = []
  for (let i = 1; i <= SECTION_COUNT; i++) {
    const t = SECTION_TIME[i - 1] || ['', '']
    list.push({
      i: i,
      period: i <= 5 ? 'morning' : i <= 10 ? 'afternoon' : 'evening',
      from: t[0],
      to: t[1]
    })
  }
  return list
})()

/**
 * 课程配色在 app.wxss 的 .tone0 ~ .tone6。
 * 这里只保留「第几组颜色」的索引（course.color），颜色值本身在 CSS 里。
 * 组数要与 utils/parser.js 的 COLOR_COUNT 一致。
 */
const COLOR_COUNT = 7
const COLORS = (function () {
  const list = []
  for (let i = 0; i < COLOR_COUNT; i++) list.push(i)
  return list
})()

/** 编辑表单里可点选的周数：1-18 周各一个圆形按钮 */
const PICK_WEEKS = 18
const PICK_WEEK_LIST = (function () {
  const list = []
  for (let i = 1; i <= PICK_WEEKS; i++) list.push(i)
  return list
})()

const DAY_MS = 24 * 60 * 60 * 1000

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
  const diff = Math.round((now - start) / (7 * DAY_MS)) + 1
  return Math.min(Math.max(diff, 1), totalWeeks)
}

/**
 * 课程的上课周次，统一成升序数组。
 * 手动选过周的课程存 weekList（可以是 1,3,4,9 这种任意组合）；
 * 导入的课程只有 weeks:[起, 止] + parity，在这里展开。
 */
function weekListOf(course) {
  if (Array.isArray(course.weekList)) return course.weekList
  const list = []
  if (!course.weeks) return list
  for (let w = course.weeks[0]; w <= course.weeks[1]; w++) {
    if (course.parity === 'odd' && w % 2 === 0) continue
    if (course.parity === 'even' && w % 2 === 1) continue
    list.push(w)
  }
  return list
}

/** 判断课程在第 n 周是否上课 */
function isActiveInWeek(course, week) {
  if (Array.isArray(course.weekList)) return course.weekList.indexOf(week) > -1
  if (!course.weeks) return false
  const from = course.weeks[0]
  const to = course.weeks[1]
  if (week < from || week > to) return false
  if (course.parity === 'odd') return week % 2 === 1
  if (course.parity === 'even') return week % 2 === 0
  return true
}

/**
 * 周次数组 → 文案：
 *   [1..16]        → 第 1-16 周
 *   [1,3,5..15]    → 第 1-15 周（单周）
 *   [1,2,3,7,9,10] → 第 1-3、7、9-10 周
 */
function formatWeeks(list) {
  if (!list.length) return '未选择'
  const first = list[0]
  const last = list[list.length - 1]

  // 首尾之间隔一周一个、且至少 3 个：按单双周描述更好读
  const stepTwo = list.length >= 3 && list.every((w, i) => w === first + i * 2)
  if (stepTwo) return '第 ' + first + '-' + last + ' 周（' + (first % 2 ? '单周' : '双周') + '）'

  // 否则把连续的周压成区间
  const parts = []
  let from = first
  let prev = first
  for (let i = 1; i <= list.length; i++) {
    const w = list[i]
    if (w === prev + 1) {
      prev = w
      continue
    }
    parts.push(from === prev ? String(from) : from + '-' + prev)
    from = prev = w
  }
  return '第 ' + parts.join('、') + ' 周'
}

/** 「第 1-17 周（单周）」这样的文案 */
function weekTextOf(course) {
  return formatWeeks(weekListOf(course))
}

/** 编辑表单里周次按钮的状态：每个按钮是否选中 + 摘要 + 当前对应哪个快捷键 */
function weekPickState(picked) {
  const list = []
  picked.forEach((on, i) => { if (on) list.push(i + 1) })
  const all = PICK_WEEK_LIST
  const same = target => target.length === list.length && target.every((w, i) => w === list[i])
  let mode = ''
  if (same(all)) mode = 'all'
  else if (same(all.filter(w => w % 2 === 1))) mode = 'odd'
  else if (same(all.filter(w => w % 2 === 0))) mode = 'even'
  return { list: list, mode: mode, text: formatWeeks(list), count: list.length }
}

/** 「周三 第 3-4 节」，起止时间录入后换成时间区间 */
function timeTextOf(course) {
  const first = SECTIONS[course.start - 1]
  const last = SECTIONS[course.start + course.span - 2]
  const end = course.start + course.span - 1
  const range = (first && last && first.from && last.to)
    ? first.from + ' - ' + last.to
    : (course.span > 1 ? '第 ' + course.start + '-' + end + ' 节' : '第 ' + course.start + ' 节')
  return DAY_NAMES[course.day - 1] + ' ' + range
}

/** 'HH:MM' → 当天第几分钟，格式不对时返回 NaN */
function toMinutes(hhmm) {
  const parts = String(hhmm || '').split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (isNaN(h) || isNaN(m)) return NaN
  return h * 60 + m
}

/**
 * 此刻正在上的课：要同时满足「看的是本周」「今天是这门课的星期」
 * 「当前时间落在起始节的上课时间和结束节的下课时间之间」。
 * 节与节之间那几分钟的课间也算在上课里，和大家的直觉一致。
 *
 * 开学前 / 放假后「本周」会被夹到第 1 周或最后一周，那种日子其实不上课，
 * 所以还要用真实日期核对一遍：今天必须真的在这一周里。
 *
 * 真有时间冲突的课重叠时，取节次靠前的那门 —— 一格只标一个「上课中」。
 * 返回课程 id，没有正在上的课返回 ''。
 */
function liveCourseId(courses, week, thisWeek, term) {
  if (!term || week !== thisWeek) return ''

  const now = new Date()
  if (dateKey(mondayOfWeek(term, week)) !== dateKey(mondayOf(now))) return ''

  const day = now.getDay() === 0 ? 7 : now.getDay() // 周日算作 7
  const minutes = now.getHours() * 60 + now.getMinutes()

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i]
    if (course.day !== day || !isActiveInWeek(course, week)) continue
    const first = SECTIONS[course.start - 1]
    const last = SECTIONS[course.start + course.span - 2]
    if (!first || !last) continue
    const from = toMinutes(first.from)
    const to = toMinutes(last.to)
    if (isNaN(from) || isNaN(to)) continue
    if (minutes >= from && minutes < to) return course.id
  }
  return ''
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

/** 两门课是否在某一周同时上课（同一天、节次有交叠） */
function isConflict(a, b, totalWeeks) {
  if (a.day !== b.day) return false
  const aEnd = a.start + a.span - 1
  const bEnd = b.start + b.span - 1
  if (a.start > bEnd || b.start > aEnd) return false
  for (let w = 1; w <= totalWeeks; w++) {
    if (isActiveInWeek(a, w) && isActiveInWeek(b, w)) return true
  }
  return false
}

/** 存储里的课程 → 课表方块 / 详情弹层用的展示数据 */
function toView(course, live) {
  return {
    id: course.id,
    name: course.name,
    room: course.room || '',
    teacher: course.teacher || '',
    // color 缺失时退回 0；超出组数时取模，兼容旧数据
    color: (course.color || 0) % COLOR_COUNT,
    timeText: timeTextOf(course),
    weekText: weekTextOf(course),
    // 正在上课：方块底部压一条「上课中」。
    // 单节课的方块只有一行高，状态条会吃掉下半截，UI 上要跟着收紧（见 wxss）
    live: !!live,
    liveTight: !!live && course.span === 1,
    // 单节课的方块最矮，字号放大时要单独收一下内容（见 wxss 的 .block--single）
    single: course.span === 1,
    // 绝对定位：起始节次决定 top，节数决定 height
    style: 'top:' + ((course.start - 1) * ROW_H) + 'rpx;height:' + (course.span * ROW_H - 10) + 'rpx'
  }
}

/** 第 n 周周一 */
function mondayOfWeek(term, week) {
  const monday = mondayOf(parseDate(term.startDate))
  monday.setDate(monday.getDate() + (week - 1) * 7)
  return monday
}

/** 表头：7 天的星期 + 日期，只依赖周次不依赖课程 */
function buildHead(week, term) {
  const monday = mondayOfWeek(term, week)
  const todayKey = dateKey(new Date())
  const head = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * DAY_MS)
    head.push({
      day: i + 1,
      label: WEEK_LABELS[i],
      dayNum: d.getDate(), // 只显示「几号」，月份在周次栏的日期范围里
      isToday: dateKey(d) === todayKey
    })
  }
  return head
}

function rangeTextOf(week, term) {
  const monday = mondayOfWeek(term, week)
  const sunday = new Date(monday.getTime() + 6 * DAY_MS)
  return monday.getMonth() === sunday.getMonth()
    ? (monday.getMonth() + 1) + ' 月 ' + monday.getDate() + ' - ' + sunday.getDate() + ' 日'
    : (monday.getMonth() + 1) + ' 月 ' + monday.getDate() + ' 日 - ' +
      (sunday.getMonth() + 1) + ' 月 ' + sunday.getDate() + ' 日'
}

/**
 * 构建某一周 7 列的课程方块。
 * liveId 是「此刻正在上的课」，只有当前周会传进来，其余周一律不标。
 */
function buildCols(week, courses, head, liveId) {
  const cols = head.map(function (h) {
    return { day: h.day, isToday: h.isToday, courses: [] }
  })
  courses.forEach(function (course) {
    if (!isActiveInWeek(course, week)) return
    const col = cols[course.day - 1]
    if (!col) return
    // 节次超出时间表范围，跳过而不是崩掉
    if (course.start < 1 || course.start + course.span - 1 > SECTION_COUNT) return
    col.courses.push(toView(course, !!liveId && course.id === liveId))
  })
  return cols
}

/** 一周没加载时的占位，只有 week，swiper-item 里不渲染内容 */
function emptyWeek(week) {
  return { week: week, loaded: false, cols: [] }
}

/** picker 的选项 */
function range(from, to, fmt) {
  const list = []
  for (let i = from; i <= to; i++) list.push(fmt(i))
  return list
}

Page({
  data: {
    rowH: ROW_H,
    gridH: ROW_H * SECTION_COUNT,
    fontIndex: INITIAL_FONT_INDEX,
    blockScale: INITIAL_FONT_SCALE,
    sections: SECTIONS,
    weeks: [],      // swiper 每一页，只有当前周 ±1 是 loaded 的
    current: 0,     // swiper 当前页下标 = 周次 - 1
    head: [],
    week: 1,
    thisWeek: 1,
    totalWeeks: 20,
    weekRangeText: '',
    weekCourseCount: 0,
    isEmpty: false,
    termText: '',

    // 上课提醒额度不足时的顶部提示，null 表示不显示
    remindTip: null,

    // 空课表引导弹窗：showGuide 时课表模糊并锁住；guideLeaving 是关闭动画中
    showGuide: false,
    guideLeaving: false,

    // 点空白格出现的「＋」：{ week, day, start }，null 表示不显示
    plus: null,

    showDetail: false,
    detail: null,

    // 编辑弹层
    showEditor: false,
    editor: null,
    colors: COLORS,
    timeRange: [DAY_NAMES, range(1, SECTION_COUNT, n => '第 ' + n + ' 节'), range(1, SECTION_COUNT, n => '至第 ' + n + ' 节')],
    pickWeeks: PICK_WEEK_LIST,

    // 周次选择卡片：weekDraft 是卡片里的草稿，确定后才写回 editor
    showWeeks: false,
    weekDraft: null
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

    // 右上角「···」里放出转发和分享到朋友圈
    share.enableMenu()

    // 从导入页返回时课表可能变了，重建一次；没变就不动，免得把翻到的周次弹回去
    const stamp = store.getStamp()
    if (stamp !== this._stamp) {
      this._stamp = stamp
      this.loadData()
    }

    // 字号在「我的」页改的，切回来才生效。只改块内文字，不用重建课表
    this.syncFontLevel()

    // 在后台待过再回来：可能已经上课 / 下课了，先立刻对一次，再挂着定时器
    this.syncLive()
    this.startLiveTimer()

    // 上课提醒额度快用完时，在顶部出一条续订提示。
    // 先拿本地缓存渲染，status 内部 5 分钟才向云端确认一次
    this.applyRemindTip(reminder.readCache())
    reminder.status().then(state => this.applyRemindTip(state))

    // 云端那份也是提醒的数据源：回到课表页顺手补传一次，失败静默
    cloud.ensureBackup()
  },

  /** 把「我的」页选的字号同步过来；档位没变就不 setData，避免多余重绘 */
  syncFontLevel() {
    const index = store.getFontIndex()
    const scale = store.FONT_LEVELS[index].scale
    if (index === this.data.fontIndex && scale === this.data.blockScale) return
    this.setData({ fontIndex: index, blockScale: scale })
  },

  /* ─── 分享 ───
   * 页面没有 onShareAppMessage 时，右上角「···」里的「转发」是灰的，
   * 这就是之前小程序分享不出去的原因。 */

  onShareAppMessage() {
    const week = Number(this.data.week) || 1
    return {
      title: '第 ' + week + ' 周课表｜' + config.SHARE.title,
      path: '/pages/schedule/schedule',
      // 固定封面，避免默认截当前页把你的课表带出去
      imageUrl: '/assets/share/cover.png'
    }
  },

  onShareTimeline() {
    return {
      title: config.SHARE.timelineTitle,
      imageUrl: '/assets/share/cover.png'
    }
  },

  onHide() {
    this.stopLiveTimer()
  },

  onUnload() {
    this.stopLiveTimer()
  },

  /** 滚动时收起「＋」，避免它和手指错位 */
  onPageScroll() {
    if (this.data.plus) this.setData({ plus: null })
  },

  /** 从本地存储装配课表 */
  loadData() {
    const term = store.getTerm()
    const totalWeeks = term.totalWeeks || 20

    this._courses = store.getCourses()
    this._term = term
    this._totalWeeks = totalWeeks
    this._thisWeek = currentWeek(parseDate(term.startDate), totalWeeks)

    // 课表数据整体换了（首次进入 / 导入 / 在「我的」里清空），空的话重新问一次要不要导入。
    // 用户自己在课表页删光课程不走这里，不会再弹出来打扰。
    const isEmpty = this._courses.length === 0

    this.setData({
      weeks: range(1, totalWeeks, emptyWeek),
      isEmpty: isEmpty,
      showGuide: isEmpty,
      guideLeaving: false,
      totalWeeks: totalWeeks,
      thisWeek: this._thisWeek,
      termText: termLabel(term)
    })

    this.goWeek(this._thisWeek)
  },

  /**
   * 切到第 n 周：更新表头/周次栏，并只给 n-1、n、n+1 三页装课程。
   * 其余页清空，swiper 里同时存在的课程方块最多三周。
   *
   * 滑动触发时也要回写 current：不写的话 data 里还是旧值，
   * 之后按箭头跳回那个旧下标时 setData 前后值相同，swiper 不会动。
   */
  goWeek(week) {
    const head = buildHead(week, this._term)
    // 每次重建都重新对一次表：翻到本周时才可能有「上课中」
    this._liveId = liveCourseId(this._courses, week, this._thisWeek, this._term)
    const patch = {
      week: week,
      current: week - 1,
      head: head,
      weekRangeText: rangeTextOf(week, this._term),
      plus: null
    }

    let count = 0
    this.data.weeks.forEach((w, i) => {
      const n = i + 1
      const near = Math.abs(n - week) <= 1
      if (near) {
        const cols = buildCols(n, this._courses, n === week ? head : buildHead(n, this._term), n === week ? this._liveId : '')
        if (n === week) count = cols.reduce((sum, c) => sum + c.courses.length, 0)
        patch['weeks[' + i + ']'] = { week: n, loaded: true, cols: cols }
      } else if (w.loaded) {
        patch['weeks[' + i + ']'] = emptyWeek(n)
      }
    })
    patch.weekCourseCount = count

    this.setData(patch)
  },

  /**
   * 页面停在这一页时，时间照样在走。每半分钟对一次「上课中」，
   * 状态没变就什么都不做，变了才 setData（只改那一个方块，不动整张表）。
   */
  syncLive() {
    if (!this._courses) return
    const next = liveCourseId(this._courses, this.data.week, this._thisWeek, this._term)
    if (next === this._liveId) return
    this._liveId = next

    const patch = {}
    this.data.weeks.forEach((w, i) => {
      if (!w.loaded) return
      w.cols.forEach((col, j) => {
        col.courses.forEach((c, k) => {
          const live = !!next && c.id === next
          if (c.live !== live) {
            patch['weeks[' + i + '].cols[' + j + '].courses[' + k + '].live'] = live
          }
        })
      })
    })
    if (Object.keys(patch).length) this.setData(patch)
  },

  startLiveTimer() {
    this.stopLiveTimer()
    this._liveTimer = setInterval(() => this.syncLive(), 30000)
  },

  stopLiveTimer() {
    if (this._liveTimer) {
      clearInterval(this._liveTimer)
      this._liveTimer = null
    }
  },

  /* ─────────────── 上课提醒的续订提示 ─────────────── */

  /** 把剩余额度翻译成顶部提示条；不需要提示时收起 */
  applyRemindTip(state) {
    const tip = reminder.tipOf(state)
    const now = this.data.remindTip
    if (!tip && !now) return
    if (tip && now && tip.quota === now.quota && tip.text === now.text) return
    this.setData({ remindTip: tip })
  },

  /**
   * 点提示条续订。requestSubscribeMessage 必须在点击回调里同步调用，
   * 所以 reminder.renew() 要直接放在这里，前面不能有 await。
   */
  onRemindRenew() {
    if (this._remindBusy) return
    this._remindBusy = true

    reminder.renew().then(res => {
      this._remindBusy = false

      if (res.ok) {
        this.applyRemindTip(res)
        wx.showToast({ title: '已续订 ' + res.accepted + ' 次', icon: 'none' })
        return
      }

      const tips = {
        'no-accept': '需要授权才能提醒',
        'not-enabled': '先到「我的」开启提醒',
        'network': '网络异常，稍后再试',
        'unsupported': '提醒功能未配置'
      }
      wx.showToast({ title: tips[res.reason] || '操作失败，稍后再试', icon: 'none' })
    })
  },

  /** 课程数据变了（增删改），保持当前周重新装配 */
  refresh() {
    store.setCourses(this._courses)
    this._stamp = store.getStamp()
    // 手动增删改也算数据变化，后台补传到云端（提醒读这份镜像）。失败静默
    cloud.ensureBackup()

    // 本地被删空时提醒也停掉：云端那份是「从云端恢复」用的，不会被空课表覆盖，
    // 不停的话会继续按旧副本发提醒
    if (!this._courses.length) reminder.disable()

    this.setData({ isEmpty: this._courses.length === 0 })
    this.goWeek(this.data.week)
  },

  onSwiperChange(e) {
    // source 为空表示是程序设置 current 触发的，goWeek 已经处理过了
    if (e.detail.source !== 'touch') return
    this.goWeek(e.detail.current + 1)
  },

  onPrevWeek() {
    if (this.data.week <= 1) {
      wx.showToast({ title: '已经是第 1 周', icon: 'none' })
      return
    }
    this.goWeek(this.data.week - 1)
  },

  onNextWeek() {
    if (this.data.week >= this._totalWeeks) {
      wx.showToast({ title: '已经是第 ' + this._totalWeeks + ' 周', icon: 'none' })
      return
    }
    this.goWeek(this.data.week + 1)
  },

  /** 点击周次区域，跳回本周 */
  onToday() {
    if (this.data.week === this.data.thisWeek) {
      wx.showToast({ title: '当前就是本周', icon: 'none' })
      return
    }
    this.goWeek(this.data.thisWeek)
  },

  onImport() {
    wx.navigateTo({ url: '../login/login' })
  },

  /** 关闭引导：先播淡出动画，结束后移除弹窗、解除模糊和锁定 */
  onCloseGuide() {
    if (this.data.guideLeaving) return
    this.setData({ guideLeaving: true })
    setTimeout(() => {
      this.setData({ showGuide: false, guideLeaving: false })
    }, 200)
  },

  // ============ 空白格 → 「＋」 ============

  /**
   * 点空白格：在这一格放一个「＋」；点「＋」才真正打开添加表单。
   * 格子上有课程方块时，方块盖在上面先接到点击，所以这里只会收到空白格。
   */
  onSlotTap(e) {
    const day = Number(e.currentTarget.dataset.day)
    const start = Number(e.currentTarget.dataset.start)
    const plus = this.data.plus
    // 再点一次同一格也当作点了「＋」
    if (plus && plus.day === day && plus.start === start) {
      this.openAdd(day, start)
      return
    }
    this.setData({
      plus: {
        day: day,
        start: start,
        style: 'top:' + ((start - 1) * ROW_H) + 'rpx;height:' + (ROW_H - 10) + 'rpx'
      }
    })
  },

  onPlusTap() {
    const plus = this.data.plus
    if (plus) this.openAdd(plus.day, plus.start)
  },

  // ============ 详情弹层 ============

  onCourseTap(e) {
    const id = e.currentTarget.dataset.id
    const course = this._courses.filter(c => c.id === id)[0]
    if (!course) return
    this.setData({ detail: toView(course), showDetail: true, plus: null })
    this.syncTabBar()
  },

  onCloseDetail() {
    this.setData({ showDetail: false })
    this.syncTabBar()
  },

  onEditFromDetail() {
    const id = this.data.detail && this.data.detail.id
    const course = this._courses.filter(c => c.id === id)[0]
    this.setData({ showDetail: false })
    // 详情直接切到编辑时不同步 tabBar，否则它会先弹上来再滑下去，闪一下
    if (course) this.openEditor(course, false)
    else this.syncTabBar()
  },

  // ============ 编辑弹层 ============

  /** 新增：星期和起始节来自点中的格子，默认两节连上 */
  openAdd(day, start) {
    const span = start < SECTION_COUNT ? 2 : 1
    this.openEditor({
      name: '',
      room: '',
      teacher: '',
      day: day,
      start: start,
      span: span,
      weekList: range(1, 16, n => n), // 默认 1-16 周，大多数课都是这个
      color: this._courses.length % COLOR_COUNT // 轮着给，连续添加的课不撞色
    }, true)
  },

  openEditor(course, isNew) {
    const list = weekListOf(course)
    // 1-18 周各一个开关；导入数据里超出 18 周的部分（少见）原样保留，不让它悄悄丢掉
    const picked = PICK_WEEK_LIST.map(w => list.indexOf(w) > -1)
    this._extraWeeks = list.filter(w => w > PICK_WEEKS)

    this.setData({
      plus: null,
      showEditor: true,
      showWeeks: false,
      editor: {
        isNew: isNew,
        id: course.id,
        name: course.name || '',
        room: course.room || '',
        teacher: course.teacher || '',
        color: (course.color || 0) % COLOR_COUNT,
        // multiSelector 的下标
        time: [course.day - 1, course.start - 1, course.start + course.span - 2],
        picked: picked,
        pick: weekPickState(picked),
        extraWeeks: this._extraWeeks.length ? formatWeeks(this._extraWeeks) : ''
      }
    })
    this.syncTabBar()
  },

  onCloseEditor() {
    this.setData({ showEditor: false, showWeeks: false })
    this.syncTabBar()
  },

  onEditorInput(e) {
    this.setData({ ['editor.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onColorPick(e) {
    this.setData({ 'editor.color': Number(e.currentTarget.dataset.color) })
  },

  /** 结束节早于开始节时自动拉齐，不让用户存出非法值 */
  onTimeChange(e) {
    const v = e.detail.value.map(Number)
    if (v[2] < v[1]) v[2] = v[1]
    this.setData({ 'editor.time': v })
  },

  // ============ 选择上课周次（编辑弹层之上的第二层卡片） ============

  /** 打开周次卡片：拷一份当前选择做草稿，改动不直接影响表单 */
  onOpenWeeks() {
    const picked = this.data.editor.picked.slice()
    this.setData({
      showWeeks: true,
      weekDraft: { picked: picked, pick: weekPickState(picked) }
    })
  },

  /** 点某一周的圆形按钮：选上 / 取消 */
  onWeekToggle(e) {
    const i = Number(e.currentTarget.dataset.week) - 1
    const picked = this.data.weekDraft.picked.slice()
    picked[i] = !picked[i]
    this.setWeekDraft(picked)
  },

  /**
   * 快捷键：全选 / 单周 / 双周。
   * 「全选」在已经全选时变成「全不选」；单双周按一下就整体替换成对应的周。
   */
  onWeekQuick(e) {
    const mode = e.currentTarget.dataset.mode
    const current = this.data.weekDraft.pick.mode
    let picked
    if (mode === 'all') picked = PICK_WEEK_LIST.map(() => current !== 'all')
    else if (mode === 'odd') picked = PICK_WEEK_LIST.map(w => w % 2 === 1)
    else picked = PICK_WEEK_LIST.map(w => w % 2 === 0)
    this.setWeekDraft(picked)
  },

  setWeekDraft(picked) {
    this.setData({
      'weekDraft.picked': picked,
      'weekDraft.pick': weekPickState(picked)
    })
  },

  /** 放弃本次改动 */
  onWeekCancel() {
    this.setData({ showWeeks: false })
  },

  /** 确定：草稿写回表单；超出 18 周的部分也算，所以只有真的一周都没有才拦 */
  onWeekConfirm() {
    const draft = this.data.weekDraft
    if (!draft.pick.count && !(this._extraWeeks || []).length) {
      wx.showToast({ title: '请至少选择一周', icon: 'none' })
      return
    }
    this.setData({
      showWeeks: false,
      'editor.picked': draft.picked,
      'editor.pick': draft.pick
    })
  },

  onSaveCourse() {
    const ed = this.data.editor
    const name = ed.name.trim()
    if (!name) {
      wx.showToast({ title: '请填写课程名称', icon: 'none' })
      return
    }

    const weekList = ed.pick.list.concat(this._extraWeeks || [])
    if (!weekList.length) {
      wx.showToast({ title: '请至少选择一周', icon: 'none' })
      return
    }

    const fields = {
      name: name,
      room: ed.room.trim(),
      teacher: ed.teacher.trim(),
      day: ed.time[0] + 1,
      start: ed.time[1] + 1,
      span: ed.time[2] - ed.time[1] + 1,
      // weekList 是准数据；weeks 留着首尾两周，给只认区间的旧逻辑兜底
      weekList: weekList,
      weeks: [weekList[0], weekList[weekList.length - 1]],
      parity: undefined,
      color: ed.color
    }

    let saved
    if (ed.isNew) {
      // 只用时间戳会在同一毫秒内撞 id（删除时会连带删掉另一门），再拼一段随机数
      const id = 'manual-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      saved = Object.assign({ id: id, source: 'manual' }, fields)
      this._courses.push(saved)
    } else {
      const index = this._courses.findIndex(c => c.id === ed.id)
      if (index < 0) return
      saved = Object.assign({}, this._courses[index], fields, { edited: true })
      this._courses[index] = saved
    }

    // 时间冲突只提醒、不拦：现实里确实有冲突课和临时调课
    const clash = this._courses.filter(c => c.id !== saved.id && isConflict(c, saved, this._totalWeeks))[0]

    this.setData({ showEditor: false, showWeeks: false })

    this.syncTabBar()
    this.refresh()

    wx.showToast({
      title: clash ? '已保存，与「' + clash.name + '」时间重叠' : (ed.isNew ? '已添加' : '已保存'),
      icon: clash ? 'none' : 'success'
    })
  },

  onDeleteCourse() {
    const ed = this.data.editor
    wx.showModal({
      title: '删除课程',
      content: '确定删除「' + (ed.name || '这门课') + '」吗？所有周次都会一起删除。',
      confirmText: '删除',
      confirmColor: '#B3402F',
      success: res => {
        if (!res.confirm) return
        this._courses = this._courses.filter(c => c.id !== ed.id)
        this.setData({ showEditor: false, showWeeks: false })
        this.syncTabBar()
        this.refresh()
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  /**
   * 有底部弹层（详情 / 编辑）时把 tabBar 滑走，关掉后滑回来。
   * 自定义 tabBar 在页面之上的独立层，z-index 盖不住，只能让它让开。
   */
  syncTabBar() {
    const bar = typeof this.getTabBar === "function" && this.getTabBar()
    if (!bar) return
    // 周次卡片只会叠在编辑弹层上打开，showEditor 已经覆盖；一并写上防止以后单独打开时漏掉
    const hidden = !!(this.data.showDetail || this.data.showEditor || this.data.showWeeks)
    if (bar.data.hidden !== hidden) bar.setData({ hidden: hidden })
  },

  /** 阻止蒙层下的页面跟着滚动 */
  noop() {}
})
