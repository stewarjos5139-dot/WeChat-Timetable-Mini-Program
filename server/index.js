// server/index.js
/**
 * 最薄的 HTTP 包装，把 server/zfsoft.js 暴露成一个接口。
 *
 * 生产环境由 nginx 反代：本进程只监听 127.0.0.1，TLS 和证书全交给 nginx，
 * 所以这里不需要 https 模块。配置见 deploy/nginx.conf.example。
 */

const http = require('http')
const { fetchSchedule } = require('./zfsoft')

const PORT = Number(process.env.PORT) || 3000
// 默认只监听本机。设成 0.0.0.0 就等于绕过 nginx 直接对外，别这么干
const HOST = process.env.HOST || '127.0.0.1'

const MAX_BODY = 16 * 1024 // 这个接口只有几个短字段，用不了多大

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store' // 响应里有个人信息，别让它被缓存
  })
  res.end(body)
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = ''
    let size = 0
    req.on('data', function (chunk) {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', function () { resolve(raw) })
    req.on('error', reject)
  })
}

const server = http.createServer(async function (req, res) {
  const path = String(req.url || '').split('?')[0]

  // 健康检查。云托管会定期探活，这里必须回 200 ——
  // 之前所有非 /api/schedule 的请求一律 404，探活打到 / 会被判定为不健康、
  // 进而反复重启容器。
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    send(res, 200, { ok: true, service: 'ilove-caida' })
    return
  }

  if (req.method !== 'POST' || path !== '/api/schedule') {
    send(res, 404, { ok: false, message: 'Not Found' })
    return
  }

  try {
    const params = JSON.parse((await readBody(req)) || '{}')
    const data = await fetchSchedule(params)

    // 只记学号后四位，够定位问题又不泄露完整账号
    const tail = String(params.studentId || '').slice(-4)
    console.log('[schedule] 成功 学号***' + tail + ' → ' + data.kbList.length + ' 条')

    send(res, 200, { ok: true, data: data })
  } catch (err) {
    // ⚠️ 只记错误信息。绝不能把密码或 mm 密文写进日志
    console.error('[schedule] 失败:', (err && err.message) || err)
    send(res, 200, { ok: false, message: (err && err.message) || '服务异常' })
  }
})

server.listen(PORT, HOST, function () {
  console.log('ilove财大 中间层已启动：http://' + HOST + ':' + PORT)
  console.log(HOST === '127.0.0.1'
    ? '只监听本机，对外由 nginx 提供 HTTPS（见 deploy/README.md）'
    : '监听 ' + HOST + '，由云托管网关转发')
})

// 收到 systemd 的停止信号时干净退出，别把在途请求掐断
;['SIGTERM', 'SIGINT'].forEach(function (signal) {
  process.on(signal, function () {
    console.log('收到 ' + signal + '，正在关闭…')
    server.close(function () { process.exit(0) })
    // 兜底：10 秒还没关完就强退
    setTimeout(function () { process.exit(1) }, 10000).unref()
  })
})
