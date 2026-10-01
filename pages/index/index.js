// pages/index/index.js
const app = getApp()

/** 快捷入口，每行 4 个，共 2 行 */
const QUICK_ACTIONS = [
  { id: 'schedule', icon: '📅', label: '我的课表', tint: '#E6F7F1' },
  { id: 'score', icon: '📊', label: '成绩查询', tint: '#E8F1FE' },
  { id: 'card', icon: '💳', label: '校园卡', tint: '#FFF3E4' },
  { id: 'library', icon: '📖', label: '图书馆', tint: '#F1EDFE' },
  { id: 'canteen', icon: '🍜', label: '食堂', tint: '#FDECF1' },
  { id: 'bus', icon: '🚌', label: '校车', tint: '#FFF8E1' },
  { id: 'lost', icon: '🔍', label: '失物招领', tint: '#E8F1FE' },
  { id: 'wall', icon: '💬', label: '表白墙', tint: '#FDECF1' }
]

/** 首页展示的资讯，完整列表在 pages/news */
const NEWS = [
  {
    id: 1,
    tag: '教务',
    title: '关于 2026 年秋季学期期末考试安排的通知',
    source: '教务处',
    time: '2 小时前',
    tint: '#E6F7F1',
    color: '#0A8763'
  },
  {
    id: 2,
    tag: '学工',
    title: '2025-2026 学年国家奖学金申报工作启动',
    source: '学生工作处',
    time: '昨天',
    tint: '#E8F1FE',
    color: '#2C6BC4'
  },
  {
    id: 3,
    tag: '后勤',
    title: '图书馆国庆假期开放时间调整公告',
    source: '图书馆',
    time: '2 天前',
    tint: '#FFF3E4',
    color: '#B4761F'
  }
]

/** 今日课表 */
const COURSES = [
  {
    id: 1,
    start: '08:00',
    end: '09:40',
    name: '高等数学 A',
    loc: '三教 201',
    teacher: '张老师'
  },
  {
    id: 2,
    start: '10:00',
    end: '11:40',
    name: '微观经济学',
    loc: '五教 108',
    teacher: '李老师'
  },
  {
    id: 3,
    start: '14:00',
    end: '15:40',
    name: '大学英语（三）',
    loc: '二教 305',
    teacher: '王老师'
  }
]

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 按小时返回问候语 */
function greetingOf(hour) {
  if (hour < 6) return { title: '夜深了，同学', sub: '早点休息，明天见 🌙' }
  if (hour < 11) return { title: '早安，同学', sub: '今天也要元气满满 ☀️' }
  if (hour < 14) return { title: '中午好，同学', sub: '记得好好吃饭 🍚' }
  if (hour < 18) return { title: '下午好，同学', sub: '再坚持一下，快下课啦 🌤️' }
  return { title: '晚上好，同学', sub: '复盘一下今天的收获 ✨' }
}

Page({
  data: {
    statusBarHeight: 20,
    greeting: '',
    subGreeting: '',
    quickActions: QUICK_ACTIONS,
    newsList: NEWS,
    courseList: COURSES,
    todayText: ''
  },

  onLoad() {
    const now = new Date()
    const { title, sub } = greetingOf(now.getHours())

    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      greeting: title,
      subGreeting: sub,
      todayText: `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`
    })
  },

  /** 下拉刷新：目前是静态数据，仅做交互反馈 */
  onPullDownRefresh() {
    setTimeout(() => {
      wx.stopPullDownRefresh()
      wx.showToast({ title: '已是最新', icon: 'none' })
    }, 600)
  },

  /** 静态数据阶段，功能入口统一给个提示 */
  onAction(e) {
    const id = e.currentTarget.dataset.id
    const hit = QUICK_ACTIONS.find(item => item.id === id)
    wx.showToast({
      title: `${hit ? hit.label : '该功能'}开发中`,
      icon: 'none'
    })
  },

  onSearch() {
    wx.showToast({ title: '搜索开发中', icon: 'none' })
  },

  onNotice() {
    wx.showToast({ title: '暂无新通知', icon: 'none' })
  },

  onMoreNews() {
    wx.navigateTo({ url: '../news/news' })
  },

  onCourseTap(e) {
    const { name } = e.currentTarget.dataset
    wx.showToast({ title: name, icon: 'none' })
  }
})
