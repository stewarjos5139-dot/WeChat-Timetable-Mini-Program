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
 * 网关 / 容器层没接通。云托管冷启动、网络抖动、502 都算这一类。
 * **只有带这个码的失败才值得重试** —— 后端明确回了 ok:false 的不算（见 handleBody）。
 */
const CODE_UNREACHABLE = 'UNREACHABLE'

/**
 * 失败后等多久再试一次。数组长度 = 额外重试次数，加上首次一共 3 次，
 * 最坏多等 4.5 秒。这个数是按云托管冷启动通常几秒估的。
 */
const RETRY_DELAYS = [1500, 3000]

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

/** 传输层没接通。带 CODE_UNREACHABLE 的才会被重试 */
function unreachable(message) {
  const err = new Error(message || '服务连不上')
  err.code = CODE_UNREACHABLE
  return err
}

/**
 * 调后端。传输层失败会退避重试，业务失败直接抛。
 *
 * @param {string} path 后端路径，如 '/api/schedule'
 * @param {Object} payload 请求体
 * @param {Function} [onRetry] 每次要重试前调一次，参数是第几次重试（从 1 起）。
 *   调用方拿它改按钮文案，让用户知道为什么慢了
 * @returns {Promise<Object>} 后端 data 字段
 */
function request(path, payload, onRetry) {
  const mode = currentMode()
  if (mode === 'none') return Promise.reject(noBackendError())
  return attempt(path, payload, mode, 0, onRetry)
}

function attempt(path, payload, mode, tried, onRetry) {
  const call = mode === 'cloud' ? callCloud : callHttp

  return call(path, payload).catch(function (err) {
    // 只重试「没接通」。后端明确回的失败（密码错、课表没发布）绝不能重试 ——
    // 那是白等 4.5 秒，还可能把账号连着登三次。
    const retryable = err && err.code === CODE_UNREACHABLE
    if (!retryable || tried >= RETRY_DELAYS.length) {
      if (retryable) {
        // 重试到头了。原始报错留给排查 —— 它不会进用户看到的弹窗
        console.warn('[api] 重试用完仍连不上：' + ((err && err.message) || ''))
      }
      throw err
    }

    if (onRetry) onRetry(tried + 1)
    return delay(RETRY_DELAYS[tried]).then(function () {
      return attempt(path, payload, mode, tried + 1, onRetry)
    })
  })
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
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
        // 冷启动期间走的就是这条 —— 标记成可重试
        reject(unreachable((err && err.errMsg) || '云托管调用失败'))
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
        reject(unreachable((err && err.errMsg) || '网络请求失败'))
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
    return
  }

  // 5xx，或者压根不是 JSON（网关的错误页就是这个样子）—— 都算没接通，值得重试
  if (!body || (typeof statusCode === 'number' && statusCode >= 500)) {
    reject(unreachable('服务异常（HTTP ' + statusCode + '）'))
    return
  }

  // 到这儿说明后端明确回了 ok:false（学号密码错、课表没发布…）——
  // 那是业务答复，message 本来就是给人看的中文，别重试
  reject(new Error(body.message || ('服务异常（HTTP ' + statusCode + '）')))
}

/**
 * 碰一下后端，把可能已经缩容到 0 的容器唤醒。
 *
 * 不返回 Promise、结果完全不管 —— 唯一的作用就是让网关收到一个请求、开始拉容器。
 * 进登录页时调用：用户还得输学号密码，那十几秒正好够容器启动完。
 * 失败是常态（容器还没起来），不报错、不提示、不产生未处理的 rejection。
 */
function warmup() {
  const mode = currentMode()
  if (mode === 'none') return

  try {
    if (mode === 'cloud') {
      wx.cloud.callContainer({
        config: { env: config.CLOUD_ENV },
        path: '/health',
        method: 'GET',
        header: { 'X-WX-SERVICE': config.SERVICE_NAME },
        fail: function () {}
      })
      return
    }
    wx.request({
      url: config.BASE_URL + '/health',
      method: 'GET',
      fail: function () {}
    })
  } catch (e) {
    // 预热而已，任何异常都不该影响到页面
  }
}

/**
 * 拉取课表。后端完成登录与抓取，返回原始 kbList。
 * @param {{studentId:string, password:string, xnm:string, xqm:string}} params
 * @param {Function} [onRetry] 重试前回调，用于改「正在导入…」的文案
 * @returns {Promise<{kbList:Array, studentName:string}>}
 */
function fetchSchedule(params, onRetry) {
  return request('/api/schedule', {
    studentId: params.studentId,
    password: params.password,
    xnm: params.xnm,
    xqm: params.xqm
  }, onRetry)
}

module.exports = {
  CODE_NO_BACKEND: CODE_NO_BACKEND,
  CODE_UNREACHABLE: CODE_UNREACHABLE,
  isConfigured: isConfigured,
  fetchSchedule: fetchSchedule,
  warmup: warmup
}
