// utils/api.js
/**
 * 与中间层服务的通信。
 *
 * 为什么必须有中间层：小程序的生产环境要求所有请求域名在微信后台配置白名单，
 * 而配置学校域名需要验证域名所有权（往域名根目录传校验文件），学生做不了。
 * 何况这套登录流程要维持 JSESSIONID 会话、做 RSA 加密、跟随多跳重定向，
 * 小程序端也做不了。
 *
 *     小程序  →  中间层  →  教务系统
 *
 * 中间层有两条部署路线，配置见 utils/config.js，本文件自动判断用哪条：
 *   · 微信云托管 —— wx.cloud.callContainer 走微信内部链路，不需要域名和备案
 *   · 自建 HTTPS —— wx.request 打 BASE_URL，域名需已备案（真机要求）
 *
 * ─────────────────────────────────────────────────────────
 * 后端接口（唯一一个），实现见 server/index.js：
 *
 *   POST /api/schedule
 *   请求体：{ studentId, password, xnm, xqm }
 *     studentId 学号
 *     password  密码
 *     xnm       学年，如 "2026"
 *     xqm       学期，"3" 第一学期 / "12" 第二学期
 *
 *   成功：{ ok: true, data: { kbList: [...], studentName: "张三" } }
 *     kbList 原样返回正方系统 kbcx/xskbcx_cxXsgrkb.html 的 kbList，
 *     后端不解析，解析交给小程序端的 utils/parser.js
 *
 *   失败：{ ok: false, message: "学号或密码错误" }
 * ─────────────────────────────────────────────────────────
 */

const config = require('./config')

/** 后端还没配好时的错误码，登录页据此给出更具体的提示 */
const CODE_NO_BACKEND = 'NO_BACKEND'

/**
 * 判断走哪条路。填了云托管那组就用云托管，否则退回 BASE_URL。
 * 不做显式的模式开关 —— 少一个会忘记改的地方。
 */
function currentMode() {
  if (config.CLOUD_ENV && config.SERVICE_NAME) return 'cloud'
  if (config.BASE_URL) return 'http'
  return 'none'
}

function isConfigured() {
  return currentMode() !== 'none'
}

function noBackendError() {
  const err = new Error('尚未配置中间层地址')
  err.code = CODE_NO_BACKEND
  return err
}

/**
 * 调后端。
 * @param {string} path 后端路径，如 '/api/schedule'
 * @param {Object} payload 请求体
 * @returns {Promise<Object>} 后端 data 字段
 */
function request(path, payload) {
  const mode = currentMode()
  if (mode === 'none') return Promise.reject(noBackendError())
  if (mode === 'cloud') return callCloud(path, payload)
  return callHttp(path, payload)
}

/**
 * 路 A：云托管内部调用。不需要域名，也不需要备案。
 */
function callCloud(path, payload) {
  return new Promise(function (resolve, reject) {
    wx.cloud.callContainer({
      config: { env: config.CLOUD_ENV },
      path: path,
      method: 'POST',
      header: {
        'X-WX-SERVICE': config.SERVICE_NAME,
        'content-type': 'application/json'
      },
      data: payload,
      success: function (res) {
        handleBody(res.data, res.statusCode, resolve, reject)
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '云托管调用失败'))
      }
    })
  })
}

/**
 * 路 B：直接用 wx.request 打后端地址（自建服务，或云托管的公网域名）。
 */
function callHttp(path, payload) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.BASE_URL + path,
      method: 'POST',
      data: payload,
      header: { 'content-type': 'application/json' },
      timeout: 25000, // 后端要串行发 11 次请求到教务系统，给足时间
      success: function (res) {
        handleBody(res.data, res.statusCode, resolve, reject)
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '网络请求失败'))
      }
    })
  })
}

/**
 * 两条路的响应处理共用。
 * 不同基础库对 Content-Type 的处理有差异，拿到字符串就自己 parse。
 */
function handleBody(rawBody, statusCode, resolve, reject) {
  let body = rawBody
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch (err) {
      body = null
    }
  }

  if (body && body.ok) {
    resolve(body.data || {})
  } else {
    reject(new Error(
      (body && body.message) || ('服务异常（HTTP ' + statusCode + '）')
    ))
  }
}

/**
 * 拉取课表。后端完成登录与抓取，返回原始 kbList。
 * @param {{studentId:string, password:string, xnm:string, xqm:string}} params
 * @returns {Promise<{kbList:Array, studentName:string}>}
 */
function fetchSchedule(params) {
  return request('/api/schedule', {
    studentId: params.studentId,
    password: params.password,
    xnm: params.xnm,
    xqm: params.xqm
  })
}

module.exports = {
  CODE_NO_BACKEND: CODE_NO_BACKEND,
  isConfigured: isConfigured,
  fetchSchedule: fetchSchedule
}
