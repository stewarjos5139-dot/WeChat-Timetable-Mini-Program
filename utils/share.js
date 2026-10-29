// utils/share.js
/**
 * 分享相关的小工具。
 *
 * 页面必须自己实现 onShareAppMessage，右上角「···」里的「转发」才不是灰的；
 * 想同时出现「分享到朋友圈」，还要：
 *   1. 页面实现 onShareTimeline
 *   2. 调用 wx.showShareMenu 并把 'shareTimeline' 放进 menus
 * 少了任何一条，朋友圈那一项都不会出现。
 */

/** 打开右上角菜单里的转发 / 分享到朋友圈。每个页面 onShow 各调一次 */
function enableMenu() {
  if (typeof wx.showShareMenu !== 'function') return
  wx.showShareMenu({
    withShareTicket: true,
    menus: ['shareAppMessage', 'shareTimeline']
  })
}

module.exports = {
  enableMenu: enableMenu
}
