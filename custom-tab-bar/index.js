// custom-tab-bar/index.js
Component({
  data: {
    selected: 0,
    hidden: false, // 页面有底部弹层时由页面置为 true，见 schedule.js 的 setTabBarHidden

    // 图标在 /assets/icons，未选中为线性灰、选中为实心墨蓝
    list: [
      { pagePath: '/pages/schedule/schedule', text: '课表', icon: 'tab-schedule' },
      { pagePath: '/pages/wheel/wheel', text: '决策', icon: 'tab-wheel' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: 'tab-mine' }
    ]
  },

  methods: {
    onTap(e) {
      const { index, path } = e.currentTarget.dataset
      if (index === this.data.selected) return
      wx.switchTab({ url: path })
    }
  }
})
