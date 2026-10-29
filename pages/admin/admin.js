// pages/admin/admin.js
/**
 * 小程序内的后台管理页。入口在「我的 → 连点版本号 5 次」。
 *
 * 这一页不做任何权限判断 —— 能不能拿到数据完全由云函数 admin 决定，
 * 页面只是把 forbidden 渲染成一张「无权访问」卡片。
 */

const config = require('../../utils/config')

const USER_SIZE = 20
const LOG_SIZE = 20

function call(action, payload) {
  return new Promise(function (resolve) {
    if (!config.CLOUD_ENV || !wx.cloud) {
      resolve({ ok: false, reason: 'no-cloud' })
      return
    }
    wx.cloud.callFunction({
      name: 'admin',
      data: Object.assign({ action: action }, payload || {}),
      success(res) {
        resolve((res && res.result) || { ok: false, reason: 'empty' })
      },
      fail(err) {
        resolve({ ok: false, reason: 'network', message: (err && err.errMsg) || '' })
      }
    })
  })
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 时间戳 → 本地时间「MM-DD HH:MM」 */
function fmtTime(ts) {
  const n = Number(ts)
  if (!n) return '—'
  const d = new Date(n)
  return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** 把一条日志压成一行摘要 */
function describeLog(l) {
  const at = fmtTime(l.at)
  if (l.type === 'heartbeat') return at + '  心跳'
  if (l.type === 'scan') {
    return at + '  扫描 · 用户 ' + (l.users || 0) +
      ' · 发送 ' + (l.sent || 0) + (l.failed ? ' · 失败 ' + l.failed : '')
  }
  if (l.type === 'admin') {
    return at + '  后台 ' + (l.action || '') + (l.studentId ? ' · ' + l.studentId : '')
  }
  // action
  const parts = [at, l.action || '']
  if (l.studentId) parts.push(l.studentId)
  if (l.count !== undefined && l.count !== null) parts.push('+' + l.count)
  if (l.quota !== undefined && l.quota !== null) parts.push('额度 ' + l.quota)
  if (l.result) parts.push(l.result)
  return parts.join(' · ')
}

Page({
  data: {
    ready: false,
    forbidden: false,
    error: '',
    myOpenid: '',

    tab: 'stats',
    tabs: [
      { key: 'stats', label: '概览' },
      { key: 'users', label: '用户' },
      { key: 'logs', label: '日志' },
      { key: 'notice', label: '公告' }
    ],

    // 概览
    stats: null,
    heartbeatText: '—',
    heartbeatStale: true,

    // 用户
    users: [],
    userTotal: 0,
    userPage: 1,
    userMaxPage: 1,
    userKeyword: '',
    userLoading: false,

    // 用户详情
    detail: null,
    showDetail: false,

    // 日志
    logs: [],
    logTotal: 0,
    logPage: 1,
    logMaxPage: 1,
    logType: '',
    logTypes: [
      { key: '', label: '全部' },
      { key: 'scan', label: '扫描' },
      { key: 'action', label: '操作' },
      { key: 'heartbeat', label: '心跳' },
      { key: 'admin', label: '后台' }
    ],

    // 公告
    noticeTitle: '',
    noticeBody: '',
    noticeActive: false,
    noticeError: '',
    noticeSaving: false
  },

  onLoad() {
    this.loadStats()
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    this.loadStats().then(() => {
      if (this.data.tab === 'users') return this.loadUsers(this.data.userPage)
      if (this.data.tab === 'logs') return this.loadLogs(this.data.logPage)
      if (this.data.tab === 'notice') return this.loadNotice()
    }).then(done, done)
  },

  toast(title) {
    wx.showToast({ title: title, icon: 'none' })
  },

  /** 复制自己的 openid，方便填进白名单 */
  onCopyOpenid() {
    if (!this.data.myOpenid) return
    wx.setClipboardData({
      data: this.data.myOpenid,
      success: () => this.toast('openid 已复制')
    })
  },

  /* ─────────────── 概览 ─────────────── */

  loadStats() {
    return call('stats').then(res => {
      if (res.reason === 'forbidden') {
        this.setData({ ready: true, forbidden: true })
        // 顺手把自己的 openid 拿到页面上，免得再回数据库翻
        call('whoami').then(w => {
          if (w && w.ok && w.openid) this.setData({ myOpenid: w.openid })
        })
        return
      }
      if (!res.ok) {
        this.setData({ ready: true, error: res.message || res.reason || '加载失败' })
        return
      }
      const s = res.stats
      this.setData({
        ready: true,
        forbidden: false,
        error: '',
        stats: s,
        heartbeatText: s.lastHeartbeat ? fmtTime(s.lastHeartbeat) : '还没有心跳记录',
        heartbeatStale: !s.lastHeartbeat || (Date.now() - s.lastHeartbeat > 30 * 60 * 1000)
      })
    })
  },

  onRefresh() {
    this.loadStats().then(() => this.toast('已刷新'))
  },

  /* ─────────────── 切页 ─────────────── */

  switchTab(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.tab) return
    this.setData({ tab: key })

    if (key === 'users' && !this.data.users.length) this.loadUsers(1)
    if (key === 'logs' && !this.data.logs.length) this.loadLogs(1)
    if (key === 'notice') this.loadNotice()
  },

  /* ─────────────── 用户 ─────────────── */

  loadUsers(page) {
    const p = page || 1
    this.setData({ userLoading: true })

    return call('users', {
      page: p,
      size: USER_SIZE,
      keyword: this.data.userKeyword
    }).then(res => {
      if (!res.ok) {
        this.setData({ userLoading: false })
        this.toast('加载失败')
        return
      }
      const rows = (res.rows || []).map(function (r) {
        const reminder = r.reminder
        let quotaText = '未开启提醒'
        if (reminder && reminder.enabled) quotaText = '剩余 ' + reminder.quota + ' 次'
        return Object.assign({}, r, {
          updatedText: fmtTime(r.updatedAt),
          quotaText: quotaText
        })
      })
      this.setData({
        users: rows,
        userTotal: res.total,
        userPage: res.page,
        userMaxPage: Math.max(1, Math.ceil(res.total / USER_SIZE)),
        userLoading: false
      })
    })
  },

  onUserSearch(e) {
    const keyword = e.detail.value || ''
    this.setData({ userKeyword: keyword })
    clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.loadUsers(1), 300)
  },

  onUserPrev() {
    if (this.data.userPage <= 1) return
    this.loadUsers(this.data.userPage - 1)
  },

  onUserNext() {
    if (this.data.userPage >= this.data.userMaxPage) return
    this.loadUsers(this.data.userPage + 1)
  },

  openUser(e) {
    const studentId = e.currentTarget.dataset.id
    if (!studentId) return

    wx.showLoading({ title: '加载中', mask: true })
    call('userDetail', { studentId: studentId }).then(res => {
      wx.hideLoading()
      if (!res.ok) {
        this.toast('打不开这个用户')
        return
      }
      const courses = (res.courses || []).map(function (c) {
        const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
        return Object.assign({}, c, {
          timeText: (dayNames[c.day] || '') + ' 第 ' + c.start + '-' + (c.start + c.span - 1) + ' 节'
        })
      })
      this.setData({
        detail: Object.assign({}, res, {
          courses: courses,
          updatedText: fmtTime(res.updatedAt),
          reminder: res.reminder ? Object.assign({}, res.reminder, {
            lastSentText: res.reminder.lastSentDate || '—'
          }) : null
        }),
        showDetail: true
      })
    })
  },

  closeUser() {
    this.setData({ showDetail: false })
  },

  /* ─────────────── 用户详情里的两个危险操作 ─────────────── */

  onDeleteSchedule() {
    const detail = this.data.detail
    if (!detail) return

    wx.showModal({
      title: '删除云端课表？',
      content: '会删掉学号 ' + detail.studentId + ' 的整份云端课表备份。该用户的上课提醒会因为读不到课表而发不出去，直到他下次打开小程序（会自动重新上传）。操作不可撤销。',
      confirmText: '删除',
      confirmColor: '#B3402F',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中', mask: true })
        call('deleteSchedule', { studentId: detail.studentId }).then(r => {
          wx.hideLoading()
          if (!r.ok) {
            this.toast(r.message || '删除失败')
            return
          }
          this.setData({ showDetail: false })
          this.toast('已删除')
          this.loadUsers(this.data.userPage)
          this.loadStats()
        })
      }
    })
  },

  onCloseReminder() {
    const detail = this.data.detail
    if (!detail) return

    wx.showModal({
      title: '关闭他的提醒？',
      content: '会把学号 ' + detail.studentId + ' 的提醒开关关掉，并标记为需要重新订阅。用户需要自己在小程序里重新开启。',
      confirmText: '关闭',
      confirmColor: '#B3402F',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        call('closeReminder', { studentId: detail.studentId }).then(r => {
          wx.hideLoading()
          if (!r.ok) {
            this.toast(r.message || '操作失败')
            return
          }
          this.setData({ showDetail: false })
          this.toast(r.updated ? '已关闭' : '没有找到提醒记录')
          this.loadUsers(this.data.userPage)
          this.loadStats()
        })
      }
    })
  },

  /* ─────────────── 日志 ─────────────── */

  loadLogs(page) {
    const p = page || 1
    return call('logs', {
      page: p,
      size: LOG_SIZE,
      type: this.data.logType
    }).then(res => {
      if (!res.ok) {
        this.toast('日志加载失败')
        return
      }
      const rows = (res.rows || []).map(function (l, i) {
        const detailLines = Array.isArray(l.details)
          ? l.details.map(function (d) {
            return (d.studentId || '-') + '：' + (d.action || '')
          })
          : null
        return Object.assign({}, l, {
          key: (l.at || 0) + '-' + i,
          text: describeLog(l),
          detailLines: detailLines
        })
      })
      this.setData({
        logs: rows,
        logTotal: res.total,
        logPage: res.page,
        logMaxPage: Math.max(1, Math.ceil(res.total / LOG_SIZE))
      })
    })
  },

  onLogType(e) {
    const type = e.currentTarget.dataset.key || ''
    if (type === this.data.logType) return
    this.setData({ logType: type })
    this.loadLogs(1)
  },

  onLogPrev() {
    if (this.data.logPage <= 1) return
    this.loadLogs(this.data.logPage - 1)
  },

  onLogNext() {
    if (this.data.logPage >= this.data.logMaxPage) return
    this.loadLogs(this.data.logPage + 1)
  },

  onClearLogs() {
    wx.showModal({
      title: '清理 30 天前的日志？',
      content: '只删 reminder_logs 里 30 天以前的记录，最近的日志和统计数据不受影响。',
      confirmText: '清理',
      confirmColor: '#B3402F',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '清理中', mask: true })
        call('clearLogs', { beforeTs: Date.now() - 30 * 24 * 3600 * 1000 }).then(r => {
          wx.hideLoading()
          if (!r.ok) {
            this.toast(r.message || '清理失败')
            return
          }
          this.toast('已清理 ' + r.removed + ' 条')
          this.loadLogs(1)
        })
      }
    })
  },

  /* ─────────────── 公告 ─────────────── */

  loadNotice() {
    return call('noticeGet').then(res => {
      if (!res.ok) {
        this.setData({ noticeError: res.message || '读取失败' })
        return
      }
      const n = res.notice || {}
      this.setData({
        noticeError: '',
        noticeTitle: n.title || '',
        noticeBody: n.body || '',
        noticeActive: !!n.active
      })
    })
  },

  onNoticeTitle(e) {
    this.setData({ noticeTitle: e.detail.value })
  },

  onNoticeBody(e) {
    this.setData({ noticeBody: e.detail.value })
  },

  onNoticeDraft() {
    wx.showModal({
      title: '保存内容？',
      content: '只保存标题和正文，不会改变弹窗开关，也不会触发重新推送。想让所有人重新看到，用「发布」。',
      confirmText: '保存',
      confirmColor: '#2F4A8A',
      success: res => {
        if (res.confirm) this.saveNotice(false)
      }
    })
  },

  /** 弹窗总开关：关掉就彻底不弹，跟内容和批次无关 */
  onToggleNotice() {
    const next = !this.data.noticeActive

    wx.showLoading({ title: next ? '开启中' : '关闭中', mask: true })
    call('noticeToggle', { active: next }).then(res => {
      wx.hideLoading()

      if (!res.ok) {
        this.toast(res.message || '操作失败')
        return
      }
      this.setData({ noticeActive: !!res.active })
      this.toast(res.active ? '弹窗已开启' : '弹窗已关闭')
    })
  },

  onNoticePublish() {
    wx.showModal({
      title: '发布给所有人？',
      content: '所有用户下次打开小程序都会看到这条公告，之前看到过旧内容的也会重新弹一次。',
      confirmText: '发布',
      confirmColor: '#2F4A8A',
      success: res => {
        if (res.confirm) this.saveNotice(true)
      }
    })
  },

  saveNotice(publish) {
    const title = String(this.data.noticeTitle || '').trim()
    const body = String(this.data.noticeBody || '').trim()

    if (!title) {
      this.toast('标题不能为空')
      return
    }
    if (!body) {
      this.toast('正文不能为空')
      return
    }
    if (this.data.noticeSaving) return

    this.setData({ noticeSaving: true })
    wx.showLoading({ title: publish ? '发布中' : '保存中', mask: true })

    call(publish ? 'noticePublish' : 'noticeSave', { title: title, body: body }).then(res => {
      wx.hideLoading()
      this.setData({ noticeSaving: false })

      if (!res.ok) {
        this.toast(res.message || '保存失败')
        return
      }
      this.setData({
        noticeActive: !!res.notice.active,
        noticeError: ''
      })
      this.toast(publish ? '已发布' : '草稿已保存')
    })
  },

  /** 阻止蒙层下的页面跟着滚动 */
  noop() {}
})
