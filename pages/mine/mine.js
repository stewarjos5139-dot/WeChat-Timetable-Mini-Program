// pages/mine/mine.js
const config = require('../../utils/config')
const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
const reminder = require('../../utils/reminder')
const share = require('../../utils/share')

const VERSION = '0.2.2'

/** 可选的课前提醒分钟数，来自 utils/reminder.js（与服务端白名单一致） */
const LEAD_OPTIONS = reminder.LEAD_OPTIONS
const LEAD_LABELS = LEAD_OPTIONS.map(function (m) { return m + ' 分钟' })

/** 课表字号档位，来自 utils/store.js */
const FONT_LABELS = store.FONT_LEVELS.map(function (level) { return level.label })
const FONT_LAST = store.FONT_LEVELS.length - 1
/** 滑杆圆点直径（rpx），与 mine.wxss 的 .fs-knob 保持一致 */
const FONT_KNOB_RPX = 40

/** rpx → px。movable-view 的 x 只认 px，所以量出来的宽度要换算 */
function rpx2px(rpx) {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
  return (rpx * (info.windowWidth || 375)) / 750
}

Page({
  data: {
    version: VERSION,
    hasSchedule: false,
    termText: '',

    // 课表方块字号。fontKnobX / fontFillWidth 是滑杆的 px 位置，量出轨道宽度后才有值
    fontLabels: FONT_LABELS,
    fontIndex: store.getFontIndex(),
    fontKnobX: 0,
    fontFillWidth: 0,
    fontDragging: false,

    // 公众号入口。没配原始 ID 时整行不渲染
    officialAccount: config.OFFICIAL_ACCOUNT,

    // 上课提醒
    remindOn: false,          // 开关
    remindQuota: 0,           // 剩余可发条数
    remindMax: reminder.DEFAULT_MAX_QUOTA,
    remindQuotaText: '未开启', // 次数那一行的右侧文案
    remindLead: reminder.DEFAULT_LEAD,
    leadLabels: LEAD_LABELS,
    leadIndex: LEAD_OPTIONS.indexOf(reminder.DEFAULT_LEAD),

    // 用户档案：导入课表时从教务系统拿到姓名和学号，存在本地。
    // 从没导入过时 loggedIn 为 false，其余为空。
    loggedIn: false,
    name: '',
    initial: '',   // 姓名首字，做头像用
    subText: '',

    // 底部轻提示（替代 wx.showToast，后者固定弹在屏幕正中）
    tipText: '',
    tipShow: false
  },

  /** 贴底提示，1.8 秒后自动收起 */
  tip(text) {
    if (!text) return
    clearTimeout(this._tipTimer)
    this.setData({ tipText: text, tipShow: true })
    this._tipTimer = setTimeout(() => {
      this.setData({ tipShow: false })
    }, 1800)
  },

  onUnload() {
    clearTimeout(this._tipTimer)
  },

  onReady() {
    this.measureFontBar()
  },

  /* ─── 分享 ───
   * 「分享给同学」用的是 <button open-type="share">，走的就是下面这个回调；
   * 右上角「···」里的转发和分享到朋友圈也走这里。 */

  onShareAppMessage() {
    return {
      title: config.SHARE.title,
      path: '/pages/schedule/schedule',
      imageUrl: '/assets/share/cover.png'
    }
  },

  onShareTimeline() {
    return {
      title: config.SHARE.timelineTitle,
      imageUrl: '/assets/share/cover.png'
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    share.enableMenu()
    this.refresh()
    this.refreshReminder()

    const fontIndex = store.getFontIndex()
    if (fontIndex !== this.data.fontIndex) this.setData({ fontIndex: fontIndex })
    // 圆点位置按档位重算；首次进页面时轨道还没渲染，这里再量一次
    this.measureFontBar()
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

  /* ─────────────── 上课提醒 ─────────────── */

  /** 先用本地缓存渲染（秒开），再强制向云端确认 */
  refreshReminder() {
    const cache = reminder.readCache()
    if (cache) this.applyReminder(cache)
    // 次数可能刚被定时器扣到 0（服务端会自动关闭提醒），所以这里不走 5 分钟缓存
    reminder.status(true).then(state => {
      if (state) this.applyReminder(state)
    })
  },

  applyReminder(state) {
    // 服务端/缓存里没有提前量时沿用界面上的值，别把用户刚选的覆盖成缺省
    const lead = reminder.normalizeLead(state && state.leadMinutes, this.data.remindLead)
    const on = !!(state && state.enabled)
    const quota = Math.max(0, Number(state && state.quota) || 0)
    const max = Math.max(1, Number(state && state.maxQuota) || this.data.remindMax)

    let quotaText = '未开启'
    if (on) {
      if (state.needSubscribe || quota <= 0) quotaText = '已用完'
      else if (quota >= max) quotaText = '已满 · ' + quota + ' 次'
      else quotaText = '还剩 ' + quota + ' 次'
    }

    this.setData({
      remindOn: on,
      remindQuota: quota,
      remindMax: max,
      remindQuotaText: quotaText,
      remindLead: lead,
      leadIndex: LEAD_OPTIONS.indexOf(lead)
    })
  },

  /** 提醒功能没配置时的说明 */
  showRemindSetup() {
    wx.showModal({
      title: '上课提醒未配置',
      content: '需要先在公众平台选好订阅消息模板，并把模板 ID 填进 utils/config.js 和 cloudfunctions/reminder/config.js。步骤见《订阅消息提醒.md》。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2F4A8A'
    })
  },

  /** 开启 / 续订失败时的统一提示 */
  handleRemindError(res) {
    // 云端没有课表备份，提醒发不出去 —— 说清楚怎么补
    if (res.reason === 'no-schedule') {
      wx.showModal({
        title: '课表还没同步到云端',
        content: '提醒要用云端那份课表。请先重新导入一次课表，或随便编辑一门课让它自动上传，再来开启提醒。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#2F4A8A'
      })
      return
    }

    // 本地缓存偏旧：服务端其实已经没次数了。
    // 刷新一次缓存，用户再点一下就会走订阅授权
    if (res.reason === 'no-quota') {
      reminder.status(true)
      this.tip('次数不足，再点一次开启')
      return
    }

    const tips = {
      'no-accept': '需要授权才能提醒',
      'no-local-schedule': '先导入课表',
      'not-owner': '请先导入自己的课表',
      'not-enabled': '先开启提醒',
      'network': '网络异常，稍后再试',
      'unsupported': '提醒功能未配置'
    }
    this.tip(tips[res.reason] || '操作失败，稍后再试')
  },

  /**
   * 开关：没开就开启，已开就直接关闭（不再弹确认框）。
   * 开启时必须在点击回调里同步调用 requestSubscribeMessage，
   * 所以这一行之前不能有 await / 网络请求。
   */
  onRemindToggle() {
    if (this._remindBusy) return

    if (this.data.remindOn) {
      this.disableReminder()
      return
    }

    if (!reminder.supported()) {
      this.showRemindSetup()
      return
    }

    const profile = store.getProfile()
    if (!profile || !profile.studentId) {
      this.tip('先导入课表')
      return
    }

    this._remindBusy = true
    // 同步发起订阅，别在这一行之前加 await
    reminder.enable(profile.studentId, this.data.remindLead).then(res => {
      this._remindBusy = false
      if (res.ok) {
        this.applyReminder(res)
        this.tip('已开启提醒')
        return
      }
      this.handleRemindError(res)
    })
  },

  /** 获取提醒次数：点一次获取 1 条（一次订阅授权只能换一条） */
  onGetQuota() {
    if (this._remindBusy) return

    if (!this.data.remindOn) {
      this.tip('先开启提醒')
      return
    }

    // 到上限就别再弹订阅授权了，服务端也不会再加
    if (this.data.remindQuota >= this.data.remindMax) {
      this.tip('提醒次数已满（' + this.data.remindMax + ' 次）')
      return
    }

    if (!reminder.supported()) {
      this.showRemindSetup()
      return
    }

    this._remindBusy = true
    reminder.renew().then(res => {
      this._remindBusy = false
      if (res.ok) {
        this.applyReminder(res)
        this.tip('已获取 ' + res.accepted + ' 次')
        return
      }
      this.handleRemindError(res)
    })
  },

  /** 切换课前几分钟提醒：先更新界面，再落库 */
  onLeadChange(e) {
    const index = Number(e.detail.value)
    const minutes = LEAD_OPTIONS[index]
    if (!minutes) return

    this.setData({ remindLead: minutes, leadIndex: index })

    reminder.setLead(minutes).then(res => {
      if (res.ok) {
        this.applyReminder(res)
        this.tip('成功设置课前 ' + minutes + ' 分钟提醒')
        return
      }
      if (res.reason === 'network') {
        this.tip('设置未同步，稍后重试')
      }
    })
  },

  /**
   * 量出滑杆宽度，把「档位 → 圆点位置」换算成 px。
   * 圆的 left 用的是 px，而轨道两端各缩进半个圆点，
   * 所以圆点的行程 = 区域宽度 − 圆点宽度，正好等于轨道长度。
   */
  measureFontBar() {
    this.createSelectorQuery()
      .select('.fs-area')
      .boundingClientRect(rect => {
        if (!rect || !rect.width) return
        this._fontMaxX = Math.max(1, rect.width - rpx2px(FONT_KNOB_RPX))
        const x = Math.round((this._fontMaxX * this.data.fontIndex) / FONT_LAST)
        this.setData({ fontKnobX: x, fontFillWidth: x })
      })
      .exec()
  },

  /** 按住圆点开始拖动 */
  onFontTouchStart(e) {
    const touch = e.touches && e.touches[0]
    if (!touch || !this._fontMaxX) return

    this._fontDragFrom = this.data.fontKnobX
    this._fontDragX = touch.clientX
    this._fontStartIndex = this.data.fontIndex
    if (!this.data.fontDragging) this.setData({ fontDragging: true })
  },

  /**
   * 拖动中：按手指的位移量移动圆点。
   * 用位移而不是手指的绝对位置，就不用关心页面滚到哪儿了。
   */
  onFontTouchMove(e) {
    const touch = e.touches && e.touches[0]
    const maxX = this._fontMaxX
    if (!touch || !maxX || this._fontDragX === undefined) return

    const raw = this._fontDragFrom + (touch.clientX - this._fontDragX)
    const x = Math.round(Math.min(maxX, Math.max(0, raw)))
    const index = Math.min(FONT_LAST, Math.max(0, Math.round((x / maxX) * FONT_LAST)))

    const patch = { fontKnobX: x, fontFillWidth: x }
    if (index !== this.data.fontIndex) patch.fontIndex = index
    this.setData(patch)
  },

  /** 松手：吸附到最近一档并落库 */
  onFontTouchEnd() {
    this._fontDragX = undefined
    this.setData({ fontDragging: false })

    const maxX = this._fontMaxX
    if (!maxX) return

    const saved = store.setFontIndex(this.data.fontIndex)
    const x = Math.round((maxX * saved) / FONT_LAST)
    this.setData({ fontIndex: saved, fontKnobX: x, fontFillWidth: x })

    // 只是点了一下、档位没变就不弹提示
    if (saved !== this._fontStartIndex) {
      this.tip('课表字号：' + store.FONT_LEVELS[saved].label)
    }
  },

  /** 关闭提醒：直接生效，只留一条轻提示 */
  disableReminder() {
    this._remindBusy = true
    reminder.disable().then(state => {
      this._remindBusy = false
      if (state && state.ok) {
        this.applyReminder(state)
        this.tip('已关闭')
        return
      }
      this.tip('操作失败，稍后再试')
    })
  },

  onImport() {
    wx.navigateTo({ url: '../login/login' })
  },

  /**
   * 后台入口：2 秒内连点版本号 5 次。
   * 只是不想让入口显眼，真正的权限在云函数 admin 里按 openid 判。
   */
  onVersionTap() {
    const now = Date.now()
    if (now - (this._verAt || 0) > 2000) this._verCount = 0
    this._verAt = now

    this._verCount = (this._verCount || 0) + 1
    if (this._verCount < 5) return

    this._verCount = 0
    wx.navigateTo({ url: '../admin/admin' })
  },

  onClearSchedule() {
    if (!this.data.hasSchedule) {
      this.tip('还没有导入课表')
      return
    }

    const self = this
    wx.showModal({
      title: '清除课表数据',
      // 提醒读的是云端那份课表，本地清空后云端还在，
      // 不关掉的话每天还会继续收到提醒
      content: '会删除本机已导入的课表，不影响学校教务系统的数据。' +
        (this.data.remindOn ? '上课提醒也会一并关闭。' : ''),
      confirmText: '清除',
      confirmColor: '#B3402F',
      success(res) {
        if (!res.confirm) return
        store.clearCourses()
        if (self.data.remindOn) {
          reminder.disable().then(state => {
            if (state && state.ok) self.applyReminder(state)
          })
        }
        self.refresh()
        this.tip('已清除')
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
        this.tip('已恢复 ' + res.count + ' 门课')
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

  /**
   * 打开公众号主页（wx.openOfficialAccountProfile，基础库 3.7.10+）。
   * 这个接口只允许在点击行为里调用，所以不能先 await 别的再跳。
   */
  onOpenOfficialAccount() {
    const account = config.OFFICIAL_ACCOUNT || {}
    if (!account.username) return

    if (typeof wx.openOfficialAccountProfile !== 'function') {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信版本不支持直接打开公众号主页，请升级微信后再试。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#2F4A8A'
      })
      return
    }

    wx.openOfficialAccountProfile({
      username: account.username,
      fail: () => this.showOfficialFallback()
    })
  },

  /** 跳不过去时的兜底：配了名称就提示搜索，并支持一键复制 */
  showOfficialFallback() {
    const account = config.OFFICIAL_ACCOUNT || {}
    const name = String(account.name || '').trim()

    if (!name) {
      wx.showModal({
        title: '暂时打不开',
        content: '请在微信里搜索公众号名称关注。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#2F4A8A'
      })
      return
    }

    wx.showModal({
      title: '关注公众号',
      content: '请在微信里搜索「' + name + '」并关注。',
      confirmText: '复制名称',
      cancelText: '知道了',
      confirmColor: '#2F4A8A',
      success: res => {
        if (!res.confirm) return
        wx.setClipboardData({
          data: name,
          success: () => this.tip('名称已复制')
        })
      }
    })
  },

  /** 关于：正常介绍，不再夹带作者吐槽 */
  onAbout() {
    wx.showModal({
      title: '关于 星瞢课表',
      content: '版本 ' + VERSION + '\n一款由校友制作的校园课表小程序\n\n支持从教务系统导入课表、上课前提醒、实时标注正在上的课，以及决策转盘等小工具。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2F4A8A'
    })
  },

  /** 作者的话：把「为什么没有广告」单独说清楚 */
  onAuthorNote() {
    wx.showModal({
      title: '作者的话',
      content: '鉴于本人实在受不了市面上课表软件（某wake）各种又臭又长的广告和会员弹窗。所以干脆就自己作了一款课表小程序。顺带分享了出来\n所以它永久免费且无广。\n只是供自己使用，不会做大。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#2F4A8A'
    })
  }
})
