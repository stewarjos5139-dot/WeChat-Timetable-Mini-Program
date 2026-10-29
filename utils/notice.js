// utils/notice.js
/**
 * 公告弹窗的客户端读取。
 *
 * 公告存在云数据库的 notices 集合（固定一条 _id: 'current'），
 * 由「我的 → 连点版本号 5 次 → 后台 → 公告」发布。
 *
 * 规则：只在 version 比本机记住的大时弹一次。后台点一次「发布」version 就 +1，
 * 所有人下次打开都能看到一次；看过之后同一版本不再打扰。
 *
 * 整个模块不往外抛异常 —— 公告拉不到绝不能影响小程序本身。
 */

const config = require('./config')

const COLLECTION = 'notices'
const KEY_SEEN = 'notice_seen_version'

/** 每个小程序生命周期只查一次，切 tab 不重复请求 */
let checked = false
let pending = null

function available() {
  return !!(config.CLOUD_ENV && wx.cloud && wx.cloud.database)
}

function fetchActive() {
  return new Promise(function (resolve) {
    if (!available()) {
      resolve(null)
      return
    }
    wx.cloud.database()
      .collection(COLLECTION)
      .where({ active: true })
      .limit(1)
      .get()
      .then(function (res) {
        resolve((res.data && res.data[0]) || null)
      })
      .catch(function () {
        // 集合没建、没权限、断网 —— 一律当作没有公告
        resolve(null)
      })
  })
}

function shouldShow(notice) {
  if (!notice || !notice.title) return false
  const seen = Number(wx.getStorageSync(KEY_SEEN)) || 0
  return (Number(notice.version) || 0) > seen
}

function markSeen(notice) {
  try {
    wx.setStorageSync(KEY_SEEN, Number(notice && notice.version) || 0)
  } catch (err) {
    // 存不下就下次再弹一遍，不影响使用
  }
  // 关掉之后本生命周期内不能再弹（否则切回课表 tab 会又冒出来）
  pending = null
}

/**
 * 取这次启动该弹的公告；没有则返回 null。
 * 同一个生命周期内重复调用返回同一个结果，不会重复请求。
 */
function pick() {
  if (checked) return Promise.resolve(pending)
  checked = true

  pending = fetchActive().then(function (notice) {
    return shouldShow(notice) ? notice : null
  }).catch(function () {
    return null
  })

  return pending
}

module.exports = {
  pick: pick,
  markSeen: markSeen
}
