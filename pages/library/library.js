// pages/library/library.js

/** 开馆时间段 */
const OPEN_HOUR = 8
const CLOSE_HOUR = 22

/** 规划中的功能，暂不实现 */
const FEATURES = [
  // icon 对应 /assets/icons/<icon>.svg
  { icon: 'seat', name: '座位预约', desc: '查看自习室空位并预约' },
  { icon: 'book', name: '借阅查询', desc: '在借图书与到期提醒' },
  { icon: 'room', name: '研讨间预约', desc: '预约小组讨论空间' },
  { icon: 'bell', name: '到馆提醒', desc: '心仪座位空出时通知我' }
]

Page({
  data: {
    openNow: false,
    todayHours: '',
    statusNote: '',
    features: FEATURES
  },

  onLoad() {
    const now = new Date()
    const hour = now.getHours()

    // 简单判断是否在开馆时段内（不区分节假日）
    const openNow = hour >= OPEN_HOUR && hour < CLOSE_HOUR
    let statusNote
    if (openNow) {
      statusNote = `距闭馆还有 ${CLOSE_HOUR - hour} 小时`
    } else if (hour < OPEN_HOUR) {
      statusNote = `还有 ${OPEN_HOUR - hour} 小时开馆`
    } else {
      statusNote = '明天 8:00 见'
    }

    this.setData({
      openNow,
      statusNote,
      todayHours: `${pad(OPEN_HOUR)}:00 - ${pad(CLOSE_HOUR)}:00`
    })
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
  },

  onFeatureTap(e) {
    wx.showToast({ title: `${e.currentTarget.dataset.name}开发中`, icon: 'none' })
  }
})

function pad(n) {
  return n < 10 ? `0${n}` : String(n)
}
