// pages/login/login.js
const api = require('../../utils/api')
const store = require('../../utils/store')
const parser = require('../../utils/parser')

Page({
  data: {
    studentId: '',
    password: '',
    // 在 data 里先给上默认值，保证首次渲染时 xxx[0].label 一定取得到
    yearOptions: store.buildYearOptions(),
    termOptions: store.TERM_OPTIONS,
    yearIndex: 0,
    termIndex: 0,
    startDate: '', // 第 1 周周一，'YYYY-MM-DD'
    loading: false,
    backendReady: false
  },

  onLoad() {
    const yearOptions = store.buildYearOptions()
    const term = store.getTerm()

    let yearIndex = yearOptions.findIndex(function (o) { return o.value === term.xnm })
    let termIndex = store.TERM_OPTIONS.findIndex(function (o) { return o.value === term.xqm })

    this.setData({
      yearOptions: yearOptions,
      yearIndex: yearIndex > -1 ? yearIndex : 0,
      termIndex: termIndex > -1 ? termIndex : 0,
      startDate: term.startDate,
      studentId: store.getAccount(),
      backendReady: api.isConfigured()
    })
  },

  onIdInput(e) {
    this.setData({ studentId: e.detail.value })
  },

  onPwdInput(e) {
    this.setData({ password: e.detail.value })
  },

  onYearChange(e) {
    this.setData({ yearIndex: Number(e.detail.value) })
  },

  onTermChange(e) {
    this.setData({ termIndex: Number(e.detail.value) })
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  onSubmit() {
    if (this.data.loading) return

    const studentId = this.data.studentId.trim()
    const password = this.data.password

    if (!studentId) {
      wx.showToast({ title: '请输入学号', icon: 'none' })
      return
    }
    if (!password) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
      return
    }
    if (!this.data.startDate) {
      wx.showToast({ title: '请选择开学第一周的周一', icon: 'none' })
      return
    }

    // 后端没配好就别发请求了，直接说清楚缺什么
    if (!api.isConfigured()) {
      this.showBackendTip()
      return
    }

    const params = {
      studentId: studentId,
      password: password,
      xnm: this.data.yearOptions[this.data.yearIndex].value,
      xqm: this.data.termOptions[this.data.termIndex].value,
      startDate: this.data.startDate
    }

    const start = () => {
      this.setData({ loading: true })
      this.doImport(params)
    }

    // 重新导入会整体覆盖现有课表（包括手动添加和编辑过的课程），先确认
    if (store.getCourses().length === 0) {
      start()
      return
    }
    wx.showModal({
      title: '覆盖现有课表？',
      content: '重新导入会用教务系统的数据替换当前全部课程，你手动添加和编辑过的课程也会被覆盖。',
      confirmText: '继续导入',
      confirmColor: '#B3402F',
      success: res => { if (res.confirm) start() }
    })
  },

  doImport(params) {
    const self = this

    api.fetchSchedule(params)
      .then(function (res) {
        const term = store.getTerm()
        const courses = parser.parseKbList(res.kbList, { totalWeeks: term.totalWeeks })

        if (!courses.length) {
          throw new Error('没有解析到课程。请确认学年、学期是否选对，或该学期课表是否已发布。')
        }

        store.setCourses(courses)
        store.setTerm({
          xnm: params.xnm,
          xqm: params.xqm,
          startDate: params.startDate
        })
        store.setAccount(params.studentId) // 只存学号，密码用完即弃

        const stat = parser.summarize(courses)
        wx.showToast({
          title: '已导入 ' + stat.courses + ' 门课',
          icon: 'success'
        })
        setTimeout(function () { wx.navigateBack() }, 900)
      })
      .catch(function (err) {
        self.setData({ loading: false })

        if (err && err.code === api.CODE_NO_BACKEND) {
          self.showBackendTip()
          return
        }

        wx.showModal({
          title: '导入失败',
          content: (err && err.message) || '未知错误',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#2F4A8A'
        })
      })
  },

  showBackendTip() {
    wx.showModal({
      title: '中间层未配置',
      content: '导入课表需要先连上中间层服务。\n\n请在 utils/config.js 里填上云托管的环境 ID 和服务名，或自建服务的地址。步骤见 server/deploy/cloud-hosting.md。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2F4A8A'
    })
  }
})
