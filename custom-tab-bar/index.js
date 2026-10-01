// custom-tab-bar/index.js
Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/schedule/schedule', text: '课表', icon: '📅' },
      { pagePath: '/pages/library/library', text: '图书馆', icon: '📖' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: '👤' }
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
