// server/zfsoft.js
/**
 * 正方教务系统课表抓取。
 *
 * 纯 Node 模块，不依赖任何 Web 框架 —— 自建服务器和微信云函数都能直接调用。
 * 协议细节由 2026-10-01 的实际抓包确认，详见根目录的《后端接入说明.md》。
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const HOST = 'https://xk.huel.edu.cn'
const ALLOWED_HOSTNAME = 'xk.huel.edu.cn'
const PATH_LOGIN = '/jwglxt/xtgl/login_slogin.html'
const PATH_LOGOUT = '/jwglxt/xtgl/login_logoutAccount.html'
const PATH_PUBKEY = '/jwglxt/xtgl/login_getPublicKey.html'
/**
 * 课表接口的 Referer。
 *
 * 注意这个请求虽然打到 `xssygl/sykbcx_*`，但触发它的是**学生课表查询页**
 * （`kbcx/xskbcx_cxXskbcxIndex.html`）里的 JS。Referer 必须是那个页面，
 * 设成主菜单页服务端不认 —— 实测直接 404。
 */
const PATH_SCHEDULE_REFERER = '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default'

/**
 * 课表数据的候选接口。
 *
 * 页面会并发查询多个模块，我们不确定哪个真正返回课表 —— 实测 N2151 那个
 * 浏览器和我们拿到的都是 totalCount: 0（两个响应完全一致，说明请求本身没错）。
 * 所以一次把候选全试一遍并汇总，省得来回猜。
 */
/**
 * 学生个人课表数据接口。
 *
 * 2026-10-02 从页面脚本 `xskbcx.js` 的 `cxKbContent()` 里读出来的 —— 这是唯一
 * 可靠的办法。页面 HTML 里没有课表，而页面上那两个 AJAX（N2151 的首页课表、
 * N704551 的教师模块）都不是数据源：前者恒定返回 0 条，后者对学生角色无权限。
 *
 * 请求参数就是同一份脚本里 `paramMap()` 定义的那六个；
 * 响应结构 `{ kbList: [...], xsxx: {...}, ... }`，课程行仍然是 kcmc/xqj/jcs/zcd/cdmc/xm。
 */
const SCHEDULE_CANDIDATES = [
  { label: 'kbcx/xskbcx_cxXsgrkb', url: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html' }
]
/** 登录后的主菜单页，用来验证会话到底通没通 */
const PATH_MENU = '/jwglxt/xtgl/index_initMenu.html?jsdm=xs'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/** ZF_DEBUG=1 时打印每一步的细节，用来和浏览器抓包逐字段对比 */
const DEBUG = !!process.env.ZF_DEBUG

function debugLog() {
  if (!DEBUG) return
  console.log.apply(console, ['  [debug]'].concat(Array.prototype.slice.call(arguments)))
}

/* ─────────────────────────── Cookie 管理 ─────────────────────────── */

/**
 * 极简 cookie jar。只处理 key=value，够正方用了，
 * 省得为这点需求再拖 tough-cookie 两个依赖。
 */
function createJar() {
  const store = {}

  return {
    header() {
      return Object.keys(store)
        .map(function (k) { return k + '=' + store[k] })
        .join('; ')
    },

    absorb(setCookie) {
      if (!setCookie) return
      const lines = Array.isArray(setCookie) ? setCookie : [setCookie]
      lines.forEach(function (line) {
        const pair = String(line).split(';')[0]
        const idx = pair.indexOf('=')
        if (idx < 1) return
        store[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
      })
    },

    get(name) { return store[name] },
    set(name, value) { store[name] = value }
  }
}

/* ─────────────────────────── RSA 加密 ─────────────────────────── */

/** ASN.1 长度字段 */
function derLength(len) {
  if (len < 0x80) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length].concat(bytes))
}

/** 一个完整的 TLV */
function derSection(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** ASN.1 INTEGER，hex 输入 */
function derInteger(hex) {
  let buf = Buffer.from(hex, 'hex')

  // 去掉无意义的前导 0
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  buf = buf.slice(i)

  // 最高位是 1 时补一个 0x00，否则会被当成负数
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf])

  return derSection(0x02, buf)
}

/** rsaEncryption 的 OID：1.2.840.113549.1.1.1 */
const OID_RSA_ENCRYPTION = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01
])

/**
 * 用 modulus / exponent 拼出 SubjectPublicKeyInfo 的 DER。
 *
 *   SEQUENCE {
 *     SEQUENCE { OID rsaEncryption, NULL }
 *     BIT STRING {
 *       SEQUENCE { INTEGER modulus, INTEGER exponent }
 *     }
 *   }
 */
function buildPublicKeyDer(modulusHex, exponentHex) {
  const rsaKey = derSection(0x30, Buffer.concat([
    derInteger(modulusHex),
    derInteger(exponentHex)
  ]))

  const algorithm = derSection(0x30, Buffer.concat([
    derSection(0x06, OID_RSA_ENCRYPTION),
    derSection(0x05, Buffer.alloc(0)) // NULL
  ]))

  // BIT STRING 前面那个 0x00 表示「没有未使用位」
  const bitString = derSection(0x03, Buffer.concat([Buffer.from([0x00]), rsaKey]))

  return derSection(0x30, Buffer.concat([algorithm, bitString]))
}

function derToPem(der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  return '-----BEGIN PUBLIC KEY-----\n' + body + '\n-----END PUBLIC KEY-----'
}

/**
 * 公钥参数的编码格式正方有若干变体，这里逐个试：
 *
 *   1. 直接就是 hex 字符串
 *   2. base64 里包着一个 hex 字符串（少见）
 *   3. base64 里就是原始字节 —— **正方自己走的就是这条**，
 *      它的前端用 b64tohex() 把 base64 解成字节再转 hex
 *
 * 变体 3 里 modulus 还可能多一个前导 0x00（Java BigInteger.toByteArray()
 * 给正数补的符号位），交给 derInteger 去剥。
 */
function toHex(raw, label) {
  const value = String(raw || '').trim()
  if (!value) throw new Error('公钥参数为空：' + (label || ''))

  // 变体 1
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return value

  const decoded = Buffer.from(value, 'base64')

  // 变体 2
  const asAscii = decoded.toString('ascii').trim()
  if (/^[0-9a-fA-F]+$/.test(asAscii) && asAscii.length % 2 === 0) return asAscii

  // 变体 3
  if (decoded.length) return decoded.toString('hex')

  throw new Error(
    '无法识别的公钥格式（' + (label || '未知字段') + '），原始值：' + value.slice(0, 60)
  )
}

/**
 * 加密密码。1024 位密钥 + PKCS#1 v1.5 填充，输出 base64。
 *
 * 注意：密文本身就是凭据 —— 抓到一份密文可以直接重发登录，不需要知道原密码。
 * 所以别写进日志。
 *
 * （实测 Node 的 publicEncrypt 在 v1.5 下每次输出不同，带随机化。
 *   这不影响正确性，服务端只做解填充和比对。）
 */
function encryptPassword(password, modulusRaw, exponentRaw) {
  const pem = derToPem(buildPublicKeyDer(
    toHex(modulusRaw, 'modulus'),
    toHex(exponentRaw, 'exponent')
  ))

  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(password, 'utf8')
  ).toString('base64')
}

/* ─────────────────────────── csrftoken ─────────────────────────── */

/**
 * 从登录页 HTML 里找 csrftoken。
 *
 * 抓包发现服务端并不下发 csrftoken cookie，但表单里要带。
 * 那么 token 只可能来自登录页本身（隐藏字段或 JS 变量），服务端再拿它和提交值比对。
 * 这条路走不通就退回自己生成 —— 也就是最初的错误做法。
 */
function extractCsrfFromHtml(html) {
  if (!html) return ''

  const patterns = [
    /<input[^>]*id=["']csrftoken["'][^>]*value=["']([^"']*)["']/i,
    /<input[^>]*name=["']csrftoken["'][^>]*value=["']([^"']*)["']/i,
    /<input[^>]*value=["']([^"']*)["'][^>]*id=["']csrftoken["']/i,
    /csrftoken\s*[:=]\s*["']([0-9a-fA-F-]{16,})["']/i
  ]

  for (let i = 0; i < patterns.length; i++) {
    const m = html.match(patterns[i])
    if (m && m[1]) return m[1]
  }
  return ''
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

/** 按 hostname 判断是否同域，用来决定敢不敢跟着跳转（别把 cookie 送去外站） */
function sameHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname === ALLOWED_HOSTNAME
  } catch (err) {
    return false
  }
}

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(6).toString('hex')
  ].join('-')
}

async function fetchKbList(client, jar, xnm, xqm) {
  // 先 GET 一次课表查询页面。会话得"进过"这个模块，且 Referer 必须是它
  const refRes = await client.get(PATH_SCHEDULE_REFERER, {
    headers: { Cookie: jar.header(), Referer: HOST + PATH_MENU }
  })
  const refHtml = typeof refRes.data === 'string' ? refRes.data : ''
  debugLog('课表页 GET → HTTP ' + refRes.status + ' | HTML ' + refHtml.length + ' 字节')

  if (DEBUG && refHtml) {
    // 课表不在页面 HTML 里（已确认），存一份只是为了排查页面状态
    fs.writeFileSync(path.join(__dirname, '_kebiao.html'), refHtml, 'utf8')
  }

  // 参数照抄页面脚本里 paramMap() 的定义，就这六个。
  // 之前从抓包推的那些 queryModel.* / doType / nd 都是别的接口的，这里不需要。
  const body = new URLSearchParams()
  body.append('xnm', xnm)
  body.append('xqm', xqm)
  body.append('kzlx', 'ck')
  body.append('xsdm', '')
  body.append('kclbdm', '')
  body.append('kclxdm', '')

  const probeResults = []

  for (let i = 0; i < SCHEDULE_CANDIDATES.length; i++) {
    const candidate = SCHEDULE_CANDIDATES[i]

    const res = await client.post(candidate.url, body.toString(), {
      headers: {
        Cookie: jar.header(),
        // 请求头照抄 2026-10-02 抓到的 cURL。这是个 XHR（jQuery $.ajax），
        // 所以 sec-fetch-dest 是 empty、模式是 cors，和表单提交不同。
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Origin: HOST,
        Referer: HOST + PATH_SCHEDULE_REFERER,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        Priority: 'u=1, i'
      }
    })

    let data = res.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch (err) {
        data = null
      }
    }

    // 正方通用的分页包装，课程行在 items 里（不是 kbList）
    const rows = data && Array.isArray(data.items) ? data.items
      : data && Array.isArray(data.kbList) ? data.kbList
        : null

    if (rows && rows.length) {
      debugLog('候选「' + candidate.label + '」返回 ' + rows.length + ' 条 ✓')
      return {
        // xsxx.XM 是大写（页面脚本里就是这么读的）
        studentName: (data.xsxx && (data.xsxx.XM || data.xsxx.xm)) || '',
        kbList: rows
      }
    }

    // 记下这个候选为什么不行，最后一次性汇报
    let why
    if (rows) {
      why = 'HTTP ' + res.status + '，JSON 但 0 条' +
        (data && data.totalCount !== undefined ? '（totalCount=' + data.totalCount + '）' : '')
    } else if (data && typeof data === 'object') {
      why = 'HTTP ' + res.status + '，JSON 顶层字段: ' + Object.keys(data).join(', ')
    } else {
      why = 'HTTP ' + res.status + '，非 JSON：' +
        String(res.data || '').replace(/\s+/g, ' ').slice(0, 120)
    }

    debugLog('候选「' + candidate.label + '」→ ' + why)
    probeResults.push('        ' + candidate.label + ' → ' + why)
  }

  throw new Error(
    '所有候选接口都没返回课表数据\n' +
    '        参数: xnm=' + xnm + ' xqm=' + xqm + '\n' +
    probeResults.join('\n')
  )
}

/**
 * 登录教务系统并抓取指定学期的课表。
 *
 * @param {{studentId:string, password:string, xnm:string, xqm:string}} params
 * @returns {Promise<{studentName:string, kbList:Array}>}
 */
async function fetchSchedule(params) {
  const studentId = String((params && params.studentId) || '').trim()
  const password = String((params && params.password) || '')
  const xnm = String((params && params.xnm) || '').trim()
  const xqm = String((params && params.xqm) || '').trim()

  if (!studentId || !password) throw new Error('学号或密码为空')
  if (!xnm || !xqm) throw new Error('缺少学年或学期参数')

  const jar = createJar()
  const client = axios.create({
    baseURL: HOST,
    timeout: 20000,
    maxRedirects: 0, // 手动看 Location 判断登录成败
    validateStatus: function () { return true },
    headers: { 'User-Agent': USER_AGENT }
  })

  // ---- 1. 登录页，建立会话 ----
  const pageLoadedAt = Date.now() // login.js 第 2 行用页面加载时间拼 action 的 ?time=
  let res = await client.get(PATH_LOGIN)
  jar.absorb(res.headers['set-cookie'])

  const loginHtml = typeof res.data === 'string' ? res.data : ''
  debugLog('登录页 GET → HTTP ' + res.status + ' | HTML ' + loginHtml.length + ' 字节')
  debugLog('登录页 cookie: ' + (jar.header() || '(无)'))

  // csrftoken 的三个可能来源，按可信度排序：登录页 HTML > 服务端 cookie > 自己造
  const csrfFromHtml = extractCsrfFromHtml(loginHtml)
  const csrfFromCookie = jar.get('csrftoken')
  const csrf = csrfFromHtml || csrfFromCookie || uuid()

  debugLog('csrftoken 来源: ' +
    (csrfFromHtml ? '登录页 HTML' : csrfFromCookie ? '服务端 cookie' : '本地生成（可疑）') +
    ' | 值: ' + csrf)

  if (DEBUG) {
    const at = loginHtml.indexOf('csrftoken')
    debugLog('登录页中 csrftoken 出现位置: ' + (at < 0 ? '未出现' : '第 ' + at + ' 字符处'))
    if (at >= 0) {
      debugLog('上下文: ' +
        loginHtml.slice(Math.max(0, at - 150), at + 200).replace(/\s+/g, ' '))
    }
  }

  // 连续登录失败后，服务端会在登录页渲染出 #yzmDiv，要求输入验证码。
  // 这时候密码对不对都没用 —— 不带 yzm 一律返回「用户名或密码不正确」。
  // 我们没有识别验证码图片的能力，遇到就明确报错，别再继续试把账号拖进更深的锁定。
  if (/id=["']yzmDiv["']/i.test(loginHtml)) {
    const err = new Error(
      '服务端要求输入验证码，无法自动登录。\n' +
      '        登录页里出现了 #yzmDiv，这通常是连续登录失败触发的。\n' +
      '        请先用浏览器正常登录一次（手动填验证码）把状态清掉，再重试。'
    )
    err.code = 'NEED_CAPTCHA'
    throw err
  }

  // 故意不把 csrftoken 写进 cookie jar。
  //
  // 浏览器只发 JSESSIONID，不发 csrftoken cookie（cURL 抓包确认）。
  // 我一开始自作主张塞了一个想满足「双重提交校验」，结果如果服务端做的是
  // 「cookie 里存在就比对」的逻辑，我们 cookie 里只有逗号前半段、表单里是完整
  // 两段，正好对不上 —— 而不发 cookie 的浏览器反而绕过了这个校验。
  debugLog('csrftoken 只放表单，不写 cookie（和浏览器一致）')

  // ---- 2. 取 RSA 公钥 ----
  res = await client.get(PATH_PUBKEY, {
    params: { time: Date.now() },
    headers: { Cookie: jar.header() }
  })
  jar.absorb(res.headers['set-cookie'])

  let key = res.data
  if (typeof key === 'string') {
    try {
      key = JSON.parse(key)
    } catch (err) {
      key = null
    }
  }
  if (!key || !key.modulus || !key.exponent) throw new Error('未取到 RSA 公钥')

  // 解码结果必须自检：exponent 只可能是 65537（hex 010001）。
  // 如果解出来不是它，说明编码变体判断错了，得到的 modulus 是垃圾，
  // 加密会"成功"但服务端解不开 —— 表现成密码错误，很难查。
  const modulusHex = toHex(key.modulus, 'modulus')
  const exponentHex = toHex(key.exponent, 'exponent')
  debugLog('modulus  hex 长度 ' + modulusHex.length + '（' +
    (modulusHex.length / 2) + ' 字节）前 16 位 ' + modulusHex.slice(0, 16))
  debugLog('exponent hex ' + exponentHex +
    (exponentHex === '010001' ? '  ✓ 是 65537' : '  ⚠️ 不是 65537，公钥解码有问题'))
  if (exponentHex !== '010001') {
    throw new Error(
      'RSA 公钥解码异常：exponent 解出来是 ' + exponentHex + '，应该是 010001。\n' +
      '        说明 login_getPublicKey.html 的编码格式还是没认对。\n' +
      '        原始 modulus : ' + String(key.modulus).slice(0, 80) + '\n' +
      '        原始 exponent: ' + String(key.exponent).slice(0, 80)
    )
  }

  // ---- 3. 登录 ----
  // 传已经验证过的 hex，避免再过一次 toHex
  const encrypted = encryptPassword(password, modulusHex, exponentHex)
  debugLog('密码长度 ' + password.length + ' 字符（若与预期不符，说明被 shell 吃掉了特殊字符）')
  debugLog('mm 密文长度 ' + encrypted.length + ' 字符，前 20 位 ' + encrypted.slice(0, 20))

  const body = new URLSearchParams()
  // 表单体里**没有** time 字段 —— cURL 抓包确认。
  // 那个时间戳只出现在 URL 的 ?time= 上（由 login.js 第 2 行拼上去）。
  // 我一开始多塞了一个 time 字段，是多余的。
  // 带横杠和不带横杠两种形式拼起来发。HTML 里取到的值可能已经拼好了，别拼第二次
  body.append('csrftoken',
    csrf.indexOf(',') >= 0 ? csrf : csrf + ',' + csrf.replace(/-/g, ''))
  body.append('language', 'zh_CN')
  body.append('ydType', '')
  body.append('yhm', studentId)
  body.append('mm', encrypted)
  body.append('mm', encrypted) // 正方要求同一个字段提交两次，别删

  const formPreview = body.toString().replace(/mm=[^&]*/g, 'mm=<密文>')
  debugLog('Cookie: ' + jar.header())
  debugLog('表单: ' + formPreview)

  // 浏览器在提交前还会查一次「是否需要身份信息确认」（login.js 第 223 行）。
  // 返回 true 时浏览器会弹窗要求填「使用人 / 使用原因」，人就卡在那儿了。
  // 我们没法弹窗，所以只做探测 —— 如果这里返回 true，说明这条路走不通。
  try {
    const chk = await client.post('/jwglxt/xtgl/yhgl_cxXxqrCheck.html',
      'yhm=' + encodeURIComponent(studentId), {
        headers: {
          Cookie: jar.header(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: HOST + PATH_LOGIN,
          Origin: HOST
        }
      })
    debugLog('身份信息确认检查: ' + JSON.stringify(chk.data) +
      (chk.data === true || chk.data === 'true' ? '  ⚠️ 需要人工确认，自动化走不通' : '  ✓ 不需要'))
  } catch (err) {
    debugLog('身份信息确认检查失败（不影响后续）: ' + err.message)
  }

  // 提交表单前先发一次登出请求。浏览器在 yhdl() 里做的就是这一步
  // （login.js 第 467 行）。页面里其实没有 csrfTokenLogout 这个元素，
  // 浏览器取到的是 undefined，所以这里发空值即可 —— 基本是空操作，
  // 但既然浏览器会发，就照发，免得漏掉服务端的会话重置。
  try {
    const logoutRes = await client.post(PATH_LOGOUT, 'csrfTokenLogout=', {
      headers: {
        Cookie: jar.header(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: HOST + PATH_LOGIN,
        Origin: HOST
      }
    })
    // 关键：登出会作废并轮换会话，必须吸收新 cookie。
    // 浏览器是自动处理的，我们手动管 jar 就得自己来，
    // 否则后面登录还带着已作废的 JSESSIONID。
    const before = jar.get('JSESSIONID')
    jar.absorb(logoutRes.headers['set-cookie'])
    const after = jar.get('JSESSIONID')
    debugLog('已发送 login_logoutAccount.html → HTTP ' + logoutRes.status +
      (before !== after ? ' | JSESSIONID 已轮换: ' + after : ' | JSESSIONID 未变'))
  } catch (err) {
    debugLog('登出请求失败（不影响后续）: ' + err.message)
  }

  // 表单 action 是 login_slogin.html?time=<页面加载时间戳>，
  // 那个 ?time= 由 login.js 第 2 行动态拼上去，不是服务端渲染的
  // 请求头照抄浏览器的 cURL，多一条少一条都可能被服务端的行为差异坑到
  const loginHeaders = {
    Cookie: jar.header(),
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: HOST + PATH_LOGIN,
    Origin: HOST,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,image/apng,*/*;q=0.8,' +
      'application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'max-age=0',
    'Upgrade-Insecure-Requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    // 浏览器指纹头。学校若有 WAF，缺这些可能被判定为脚本而拦掉
    'sec-ch-ua': '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    Priority: 'u=0, i'
  }

  debugLog('最终 Cookie: ' + jar.header())

  res = await client.post(PATH_LOGIN + '?time=' + pageLoadedAt, body.toString(), {
    headers: loginHeaders
  })
  jar.absorb(res.headers['set-cookie'])

  const loginText = typeof res.data === 'string' ? res.data : ''
  debugLog('登录响应 → HTTP ' + res.status +
    ' | Location: ' + (res.headers.location || '(无)') +
    ' | body ' + loginText.length + ' 字节')

  // 不要靠猜 Location 来判断成败 —— 服务端的跳转链不一定按套路走。
  // 沿着跳转链走完（浏览器就是这么做的），把中间下发的 cookie 都收下。
  let next = String(res.headers.location || '')
  for (let hop = 0; next && hop < 3; hop++) {
    const url = next.indexOf('http') === 0 ? next : HOST + next
    // 按 hostname 判同域，不能拿完整 origin 比 —— 服务端跳转给的是 http://，
    // 和我们的 https:// 前缀不匹配，之前因此直接跳过了整条跳转链
    if (!sameHost(url)) break
    const followed = await client.get(url, {
      headers: { Cookie: jar.header(), Referer: HOST + PATH_LOGIN }
    })
    jar.absorb(followed.headers['set-cookie'])
    debugLog('  跳转 ' + (hop + 1) + ': HTTP ' + followed.status +
      ' | Location: ' + (followed.headers.location || '(无)'))
    next = String(followed.headers.location || '')
  }

  // 直接拿受保护页面验证会话，比猜跳转可靠
  const probe = await client.get(PATH_MENU, {
    headers: { Cookie: jar.header(), Referer: HOST + PATH_LOGIN }
  })
  const probeText = typeof probe.data === 'string' ? probe.data : ''
  const bouncedToLogin = /login_slogin/i.test(String(probe.headers.location || ''))
  const looksLikeLoginPage = /name=["']yhm["']/.test(probeText)
  const loggedIn = !bouncedToLogin && !looksLikeLoginPage

  debugLog('会话验证：GET ' + PATH_MENU + ' → HTTP ' + probe.status +
    ' | ' + (loggedIn ? '已登录 ✓' : '未登录 ✗'))

  if (!loggedIn) {
    // 到这一步才做诊断，不再靠猜
    if (/id=["']yzmDiv["']/i.test(loginText) || /验证码/.test(loginText)) {
      throw new Error(
        '登录失败，且服务端要求验证码。\n' +
        '        账号因连续失败被限制了，不是密码问题。\n' +
        '        请用浏览器正常登录一次（手动填验证码）重置后，等几分钟再试。'
      )
    }
    throw new Error(
      '登录未通过 —— 会话验证显示仍未登录。\n' +
      '        登录响应 HTTP ' + res.status +
      ' | Location: ' + (String(res.headers.location) || '(无)') + '\n' +
      '        主菜单页 HTTP ' + probe.status +
      (bouncedToLogin ? '（被弹回登录页）' : '') +
      (looksLikeLoginPage ? '（返回的是登录页内容）' : '') + '\n' +
      '        到这一步请求本身已经和浏览器逐字段对齐，若仍失败，' +
      '问题在更底层（TLS 指纹 / HTTP 版本）。'
    )
  }

  // ---- 4. 抓课表 ----
  return fetchKbList(client, jar, xnm, xqm)
}

module.exports = {
  fetchSchedule: fetchSchedule,
  // 导出内部函数方便单测
  createJar: createJar,
  toHex: toHex,
  buildPublicKeyDer: buildPublicKeyDer,
  encryptPassword: encryptPassword
}
