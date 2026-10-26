// pages/login/login.js
const api = require('../../utils/api')
const store = require('../../utils/store')
const parser = require('../../utils/parser')
const cloud = require('../../utils/cloud')

/**
 * 导入过程中的播报文案：只放积极 / 中性的说法，按顺序轮播，
 * 不和真实请求阶段严格对应 —— 目的是让用户知道程序还在正常干活。
 */
const LOADING_TEXTS = [
  '正在连接教务系统…',
  '正在登录中…',
  '正在获取课表…',
  '成功获取课表…',
  '正在解析课表…',
  '正在整理课程…'
]
const LOADING_TEXT_INTERVAL = 2400

/** 「2026-2027 学年 · 第一学期」。拼法和 pages/mine 的 subText 保持一致 */
function termLabelOf(term) {
  const startYear = parseInt(term.xnm, 10)
  if (!startYear) return ''
  let termName = ''
  store.TERM_OPTIONS.forEach(function (option) {
    if (option.value === term.xqm) termName = option.label
  })
  return startYear + '-' + (startYear + 1) + ' 学年 · ' + termName
}

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
    loadingText: '正在连接教务系统…',
    progress: 0,
    backendReady: false,
    // 导入前的设置确认卡片
    confirmVisible: false,
    confirm: null,
    result: null // 导入结果卡片，null 表示不显示
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

    // 云托管缩容到 0 之后，第一个请求要等容器启动。
    // 现在就碰一下，用户输学号密码那十几秒正好够它启动完。
    // 结果完全不管 —— 它失败是常态
    api.warmup()
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
    this._params = params

    // 先让用户核对一遍设置；确认后才真正开始导入
    const parts = String(this.data.startDate).split('-')
    const day = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    const valid = !isNaN(day.getTime())
    const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    this.setData({
      confirmVisible: true,
      confirm: {
        studentId: studentId,
        yearLabel: this.data.yearOptions[this.data.yearIndex].label,
        termLabel: this.data.termOptions[this.data.termIndex].label,
        startDate: this.data.startDate,
        weekdayText: valid ? WEEKDAY[day.getDay()] : '',
        isMonday: valid && day.getDay() === 1,
        overwrite: store.getCourses().length > 0
      }
    })
  },

  /** 确认卡片：返回修改 */
  onCancelConfirm() {
    this.setData({ confirmVisible: false })
  },

  /** 确认卡片：确认无误，开始导入 */
  onConfirmImport() {
    if (this.data.loading) return
    const params = this._params
    if (!params) return
    this.setData({ confirmVisible: false })
    this.startImport(params)
  },

  /** 开始导入：按钮进入 loading，进度条和播报文案开始走 */
  startImport(params) {
    console.log('[login] 开始导入 学号=' + (params.studentId || '-') +
      ' 学年=' + (params.xnm || '-') + ' 学期=' + (params.xqm || '-') +
      ' 开学周一=' + (params.startDate || '-'))
    this.setData({ loading: true, progress: 4 })
    this.startMessages()
    this.startProgress()
    this.doImport(params)
  },

  /** 播报文案按顺序轮播，不和真实阶段严格对应 */
  startMessages() {
    this.stopMessages()
    this._msgIndex = 0
    this.setData({ loadingText: LOADING_TEXTS[0] })
    this._msgTimer = setInterval(() => {
      this._msgIndex = (this._msgIndex + 1) % LOADING_TEXTS.length
      this.setData({ loadingText: LOADING_TEXTS[this._msgIndex] })
    }, LOADING_TEXT_INTERVAL)
  },

  stopMessages() {
    if (this._msgTimer) {
      clearInterval(this._msgTimer)
      this._msgTimer = null
    }
  },

  /** 进度条：慢慢逼近 92%，真正的跳档由 doImport 里的阶段推进 */
  startProgress() {
    // 只清进度定时器；播报定时器由 startMessages 单独管，别在这里顺手停掉
    if (this._progressTimer) {
      clearInterval(this._progressTimer)
      this._progressTimer = null
    }
    this._progressTimer = setInterval(() => {
      const p = this.data.progress
      if (p >= 92) return
      const step = Math.max(1, Math.round((92 - p) * 0.08))
      this.setData({ progress: Math.min(92, p + step) })
    }, 300)
  },

  stopProgress() {
    this.stopMessages()
    if (this._progressTimer) {
      clearInterval(this._progressTimer)
      this._progressTimer = null
    }
    if (this._finishTimer) {
      clearTimeout(this._finishTimer)
      this._finishTimer = null
    }
  },

  onUnload() {
    this.stopProgress()
  },

  doImport(params) {
    const self = this
    // 结果卡片上的「重试」要用同一份参数
    this._params = params

    api.fetchSchedule(params, function (attempt) {
      // 真实重试也不说「重试」：只把进度往前抬一档，文案继续正常轮播
      self.setData({
        progress: Math.max(self.data.progress, attempt === 1 ? 30 : 55)
      })
    })
      .then(function (res) {
        self.stopMessages()
        self.setData({
          loadingText: '正在解析课表…',
          progress: Math.max(self.data.progress, 85)
        })

        const term = store.getTerm()
        const courses = parser.parseKbList(res.kbList, { totalWeeks: term.totalWeeks })

        if (!courses.length) {
          const empty = new Error('没有解析到课程')
          empty.code = 'EMPTY'
          throw empty
        }

        store.setCourses(courses)
        store.setTerm({
          xnm: params.xnm,
          xqm: params.xqm,
          startDate: params.startDate
        })
        // 姓名和学号一起存下来，给「我的」页面显示；密码用完即弃，不落盘
        store.setProfile({
          studentId: params.studentId,
          name: res.studentName || ''
        })

        console.log('[login] 导入成功 学号=' + (params.studentId || '-') +
          ' 姓名=' + (res.studentName || '-') + ' 课程=' + courses.length + ' 条')

        // 静默传一份到云端，重装 / 换机时能恢复。失败不打扰用户
        cloud.backup()

        self.stopProgress()
        self.setData({ progress: 100 })

        // 让 100% 闪一下再切到结果卡片
        self._finishTimer = setTimeout(function () {
          self._finishTimer = null
          self.setData({
            loading: false,
            progress: 0,
            result: self.okResult(parser.summarize(courses).courses, res.studentName)
          })
        }, 220)
      })
      .catch(function (err) {
        self.stopProgress()
        self.setData({ loading: false, progress: 0 })

        const p = store.getProfile() || {}
        console.warn('[login] 导入失败 学号=' + (params.studentId || '-') +
          ' 姓名=' + (p.name || '-') + ' 错误码=' + ((err && err.code) || '-') +
          '：' + ((err && err.message) || err))

        if (err && err.code === api.CODE_NO_BACKEND) {
          self.showBackendTip()
          return
        }

        self.setData({ result: self.failResult(err) })
      })
  },

  /** 导入成功的结果卡片 */
  okResult(count, name) {
    const lines = [{ text: count + ' 门课' + (name ? ' · ' + name : ''), strong: true }]
    const label = termLabelOf(store.getTerm())
    if (label) lines.push({ text: label })

    return {
      ok: true,
      title: '导入完成',
      lines: lines,
      actions: [{ key: 'go', label: '去看看课表' }]
    }
  },

  /**
   * 把失败分拣成一张卡片。
   * **卡片里绝不出现 errMsg 那种技术串** —— 原始报错只进 console（见 utils/api.js）
   */
  failResult(err) {
    const code = err && err.code

    // 连不上，重试也用完了。多半是云托管刚被唤醒、容器还在启动
    if (code === api.CODE_UNREACHABLE) {
      return {
        ok: false,
        title: '服务暂时连不上',
        lines: [
          { text: '云端服务可能正在启动', strong: true },
          { text: '稍等十几秒再点一次重试就好' },
          { text: '如果一直这样，请过10分钟后再试' }
        ],
        actions: [
          { key: 'retry', label: '重试' },
          { key: 'dismiss', label: '返回修改' }
        ]
      }
    }

    // 接口通了，但一门课都没解析出来
    if (code === 'EMPTY') {
      return {
        ok: false,
        title: '没找到课程',
        lines: [
          { text: '请确认学年、学期选对了', strong: true },
          { text: '也可能是这学期的课表还没发布' }
        ],
        actions: [
          { key: 'dismiss', label: '返回修改' },
          { key: 'retry', label: '重试' }
        ]
      }
    }

    // 中间层通了，但它登录教务系统失败 —— 绝大多数是学号或密码不对。
    // 只留一个按钮：回表单改完直接再点「导入课表」就是重试，不用在这儿再给一个。
    // 后端那句原文只进 console（在 doImport 的 catch 里统一记录），卡片上不出现
    return {
      ok: false,
      title: '登录失败',
      lines: [{ text: '请修改密码后重试', strong: true }],
      actions: [{ key: 'dismiss', label: '返回修改' }]
    }
  },

  /** 结果卡片上的按钮，按 key 分发 */
  onResultAction(e) {
    const key = e.currentTarget.dataset.key

    if (key === 'go') {
      wx.navigateBack()
      return
    }

    if (key === 'retry') {
      const params = this._params
      this.setData({ result: null })
      if (params) this.startImport(params)
      return
    }

    // dismiss：关掉卡片，人还留在表单上，可以直接改密码或换学期
    this.setData({ result: null })
  },

  /** 结果卡片出现时挡住页面滚动和点击穿透，和课表页的引导弹窗一个套路 */
  noop() { },

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
