// pages/mine/mine.js
const VERSION = '0.1.0'

Page({
  data: {
    version: VERSION
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  onLogin() {
    wx.showToast({ title: '登录功能开发中', icon: 'none' })
  },

  onClearCache() {
    wx.clearStorage({
      success() {
        wx.showToast({ title: '缓存已清除', icon: 'none' })
      },
      fail() {
        wx.showToast({ title: '清除失败，请重试', icon: 'none' })
      }
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于 ilove财大',
      content: `版本 ${VERSION}\n一个校园课表小程序\n\n课表数据目前为本地静态数据，尚未接入教务系统。`,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#0FA97E'
    })
  }
})
