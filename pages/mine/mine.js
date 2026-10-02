// pages/mine/mine.js
const store = require('../../utils/store')

const VERSION = '0.2.0'

Page({
  data: {
    version: VERSION,
    hasSchedule: false,
    termText: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.refresh()
  },

  refresh() {
    const courses = store.getCourses()
    const term = store.getTerm()
    const startYear = parseInt(term.xnm, 10)
    let termName = ''
    store.TERM_OPTIONS.forEach(function (option) {
      if (option.value === term.xqm) termName = option.label
    })

    this.setData({
      hasSchedule: courses.length > 0,
      termText: startYear + '-' + (startYear + 1) + ' 学年 · ' + termName
    })
  },

  onImport() {
    wx.navigateTo({ url: '../login/login' })
  },

  onClearSchedule() {
    if (!this.data.hasSchedule) {
      wx.showToast({ title: '还没有导入课表', icon: 'none' })
      return
    }

    const self = this
    wx.showModal({
      title: '清除课表数据',
      content: '会删除本机已导入的课表，不影响学校教务系统的数据。',
      confirmText: '清除',
      confirmColor: '#E4572E',
      success(res) {
        if (!res.confirm) return
        store.clearCourses()
        self.refresh()
        wx.showToast({ title: '已清除', icon: 'none' })
      }
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于 ilove财大',
      content: '版本 ' + VERSION + '\n一个校园课表小程序\n\n登录后账号密码仅用于向学校教务系统发起查询，密码不会保存在本机。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#0FA97E'
    })
  }
})
