// pages/mine/mine.js
const store = require('../../utils/store')
const cloud = require('../../utils/cloud')

const VERSION = '0.2.0'

Page({
  data: {
    version: VERSION,
    hasSchedule: false,
    termText: '',

    // 用户档案：导入课表时从教务系统拿到姓名和学号，存在本地。
    // 从没导入过时 loggedIn 为 false，其余为空。
    loggedIn: false,
    name: '',
    initial: '',   // 姓名首字，做头像用
    subText: ''
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
    const profile = store.getProfile()

    const startYear = parseInt(term.xnm, 10)
    let termName = ''
    store.TERM_OPTIONS.forEach(function (option) {
      if (option.value === term.xqm) termName = option.label
    })

    this.setData({
      loggedIn: !!profile,
      // 档案有学号但没姓名（后端罕见地没返回）时退回「同学」，不显示空白
      name: profile ? (profile.name || '同学') : '',
      initial: profile && profile.name ? profile.name.charAt(0) : '',
      // 文案在这里拼好，模板只做三元选择，免得在 WXML 里做字符串拼接
      subText: profile ? '学号 ' + profile.studentId : '导入课表后自动同步',
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
      confirmColor: '#B3402F',
      success(res) {
        if (!res.confirm) return
        store.clearCourses()
        self.refresh()
        wx.showToast({ title: '已清除', icon: 'none' })
      }
    })
  },

  // ============ 从云端恢复 ============

  /**
   * 按学号找云端那条备份（一条记录一个学号）。本机没学号时 cloud.restore 会返回
   * no-account，弹窗里会说清楚差什么。
   *
   * 「重装后手动输入学号找回」那个入口还没做，之后单独设计 ——
   * cloud.restore 已经留了参数位，到时候只用改这一层。
   */
  onRestoreFromCloud() {
    this.confirmRestore()
  },

  /**
   * 本机是空的就直接恢复 —— 没什么可覆盖的，多一次确认只是碍事。
   * 本机有课表才先确认，因为会把手动加过的课一起盖掉。
   */
  confirmRestore(studentId) {
    if (!store.getCourses().length) {
      this.doRestore(studentId)
      return
    }

    wx.showModal({
      title: '从云端恢复课表？',
      content: '会用云端备份覆盖本机课表，你手动添加和编辑过的课程也会被覆盖。',
      confirmText: '恢复',
      confirmColor: '#2F4A8A',
      success: res => { if (res.confirm) this.doRestore(studentId) }
    })
  },

  doRestore(studentId) {
    wx.showLoading({ title: '正在恢复', mask: true })

    cloud.restore(studentId).then(res => {
      wx.hideLoading()

      if (res.ok) {
        this.refresh()
        wx.showToast({ title: '已恢复 ' + res.count + ' 门课', icon: 'success' })
        return
      }

      // 每种失败分开说 —— 笼统一句「失败」，用户不知道下一步该干嘛
      const tips = {
        'no-backend': ['云服务未配置', '当前没有配置云开发环境，云端备份用不了。'],
        'no-account': ['还不知道学号', '云端备份按学号存，得先知道学号才能找。在课表页导入一次课表就有了。'],
        'no-backup': ['云端没有备份', '这个学号在云端还没有课表备份。导入一次课表后会自动上传。'],
        'schema': ['备份版本不兼容', '云端备份是旧版本存的，当前版本读不了。重新导入一次课表就能覆盖它。'],
        'error': ['恢复失败', (res.message || '网络异常') + '\n\n请检查网络后重试。']
      }
      const tip = tips[res.reason] || tips['error']

      wx.showModal({
        title: tip[0],
        content: tip[1],
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#2F4A8A'
      })
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于 ilove财大',
      content: '版本 ' + VERSION + '\n一个校园课表小程序\n\n登录后账号密码仅用于向学校教务系统发起查询，密码不会保存在本机。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2F4A8A'
    })
  }
})
