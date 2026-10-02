// server/selftest.js
/**
 * 离线自测 —— 不连教务系统，验证最容易写错的两块：RSA 公钥拼装和课表解析。
 *
 * RSA 部分用 Node 自己生成一对密钥，剥出 modulus / exponent，再走和真实流程
 * 完全一样的 toHex → buildPublicKeyDer → encryptPassword，最后用私钥解密看
 * 能不能还原出原密码。能还原就说明 DER 结构拼对了。
 *
 * 跑：node selftest.js
 */

const crypto = require('crypto')
const zfsoft = require('./zfsoft')
const parser = require('../utils/parser')

let failed = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failed++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label)
  if (!ok) {
    console.log('          期望: ' + JSON.stringify(expected))
    console.log('          实际: ' + JSON.stringify(actual))
  }
}

/* ─────────────── 1. RSA：两种公钥编码变体都要能加密 ─────────────── */

const PAIR = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
const JWK = PAIR.publicKey.export({ format: 'jwk' })
const MODULUS_HEX = Buffer.from(JWK.n, 'base64url').toString('hex')
const EXPONENT_HEX = Buffer.from(JWK.e, 'base64url').toString('hex')

function decryptWithPrivateKey(cipherBase64) {
  return crypto.privateDecrypt(
    { key: PAIR.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cipherBase64, 'base64')
  ).toString('utf8')
}

console.log('\n[1] RSA 加密')

const PASSWORD = 'Test@12345'

// 变体一：modulus / exponent 直接是 hex
const cipherA = zfsoft.encryptPassword(PASSWORD, MODULUS_HEX, EXPONENT_HEX)
check('hex 变体能还原出原密码', decryptWithPrivateKey(cipherA), PASSWORD)

// 密文长度应为 128 字节 base64 = 172 字符，与抓包一致
check('密文长度 172 字符（1024 位密钥）', cipherA.length, 172)

// 变体二：base64 里包着 hex
const wrappedModulus = Buffer.from(MODULUS_HEX, 'ascii').toString('base64')
const wrappedExponent = Buffer.from(EXPONENT_HEX, 'ascii').toString('base64')
const cipherB = zfsoft.encryptPassword(PASSWORD, wrappedModulus, wrappedExponent)
check('base64 包裹 hex 变体能还原出原密码', decryptWithPrivateKey(cipherB), PASSWORD)

// 变体三：base64 里就是原始字节 —— 正方自己走的就是这条。
// 2026-10-02 联调时卡在这里，当时只处理了变体一和二。
const rawModulus = Buffer.from(MODULUS_HEX, 'hex').toString('base64')
const rawExponent = Buffer.from(EXPONENT_HEX, 'hex').toString('base64')
const cipherD = zfsoft.encryptPassword(PASSWORD, rawModulus, rawExponent)
check('base64 原始字节变体能还原出原密码', decryptWithPrivateKey(cipherD), PASSWORD)

// Java 的 BigInteger.toByteArray() 会给正数补一个前导 0x00，
// 1024 位密钥因此返回 129 字节而不是 128。剥符号位由 derInteger 负责。
const paddedModulus = Buffer.concat([
  Buffer.from([0x00]),
  Buffer.from(MODULUS_HEX, 'hex')
]).toString('base64')
const cipherE = zfsoft.encryptPassword(PASSWORD, paddedModulus, rawExponent)
check('带前导 0x00 的 modulus 也能用', decryptWithPrivateKey(cipherE), PASSWORD)

// 同一密码加密两次，都要能正确还原。
//
// 注意：不要断言「两次密文完全相同」。实测 Node 的 crypto.publicEncrypt 在
// PKCS#1 v1.5 下每次输出不同（带随机化），一开始这么断言过，是这个断言错了。
// 随机化填充不影响正确性 —— 服务端只做解填充和比对。
const cipherC = zfsoft.encryptPassword(PASSWORD, MODULUS_HEX, EXPONENT_HEX)
check('两次加密都能还原出原密码', decryptWithPrivateKey(cipherC), PASSWORD)
check('密文按 base64 解出正好 128 字节', Buffer.from(cipherC, 'base64').length, 128)

// 无法识别的格式要报错而不是静默出错
let threw = false
try {
  zfsoft.encryptPassword(PASSWORD, '这不是公钥', '也不是')
} catch (err) {
  threw = true
}
check('非法公钥格式会抛错', threw, true)

/* ─────────────── 2. 节次解析 ─────────────── */

console.log('\n[2] 节次 jcs 解析')

check('"1-2" → start=1 span=2', JSON.stringify(parser.parseJcs('1-2')), JSON.stringify({ start: 1, span: 2 }))
check('"3" → start=3 span=1', JSON.stringify(parser.parseJcs('3')), JSON.stringify({ start: 3, span: 1 }))
check('"5-8" → start=5 span=4', JSON.stringify(parser.parseJcs('5-8')), JSON.stringify({ start: 5, span: 4 }))
check('空值返回 null', parser.parseJcs(''), null)
check('非数字返回 null', parser.parseJcs('abc'), null)

/* ─────────────── 3. 周次解析 ─────────────── */

console.log('\n[3] 周次 zcd 解析')

check('"1-16周" 无单双周', JSON.stringify(parser.parseZcd('1-16周')), JSON.stringify({ weeks: [1, 16], parity: 'all' }))
check('"1-8周(单)"', JSON.stringify(parser.parseZcd('1-8周(单)')), JSON.stringify({ weeks: [1, 8], parity: 'odd' }))
check('"2-16周(双)"', JSON.stringify(parser.parseZcd('2-16周(双)')), JSON.stringify({ weeks: [2, 16], parity: 'even' }))
check('"3周" 单周次', JSON.stringify(parser.parseZcd('3周')), JSON.stringify({ weeks: [3, 3], parity: 'all' }))
check('全角括号也能认', JSON.stringify(parser.parseZcd('1-8周（单）')), JSON.stringify({ weeks: [1, 8], parity: 'odd' }))

/* ─────────────── 4. 整表解析 ─────────────── */

console.log('\n[4] kbList 整表解析')

const KB_LIST = [
  { kcmc: '高等数学A', xqj: '1', jcs: '1-2', zcd: '1-16周', cdmc: '三教201', xm: '张明', jxbmc: '高数A-01' },
  { kcmc: '形势与政策', xqj: '5', jcs: '7-8', zcd: '1-17周(单)', cdmc: '一教报告厅', xm: '郑华', jxbmc: '形势-01' },
  { kcmc: '体育', xqj: '6', jcs: '3', zcd: '3周', cdmc: '体育馆', xm: '黄磊', jxbmc: '体育-01' },
  { kcmc: '高等数学A', xqj: '3', jcs: '1-2', zcd: '1-16周', cdmc: '三教201', xm: '张明', jxbmc: '高数A-02' },
  { kcmc: '', xqj: '2', jcs: '1-2', zcd: '1-16周' },      // 空课名 → 跳过
  { kcmc: '坏数据', xqj: '9', jcs: '1-2', zcd: '1-16周' }, // 星期越界 → 跳过
  { kcmc: '缺节次', xqj: '2', jcs: '', zcd: '1-16周' }     // 无节次 → 跳过
]

const courses = parser.parseKbList(KB_LIST, { totalWeeks: 20 })

check('跳过脏数据后剩 4 条', courses.length, 4)
check('按星期排序', courses.map(function (c) { return c.day }).join(','), '1,3,5,6')
check('空教室补占位', courses[0].room, '三教201')
check('单周课 parity=odd', courses[2].parity, 'odd')
check('每周课 parity=undefined', courses[0].parity, undefined)
check('单周次 weeks=[3,3]', JSON.stringify(courses[3].weeks), JSON.stringify([3, 3]))
// 同名课程必须同色，否则同一门课在表里花里胡哨
check('同名课程配色一致', courses[0].color, courses[1].color)
check('id 不重复', new Set(courses.map(function (c) { return c.id })).size, 4)

const stat = parser.summarize(courses)
check('去重后 3 门课', stat.courses, 3)
check('课块 4 个', stat.slots, 4)

/* ─────────────── 5. Cookie jar ─────────────── */

console.log('\n[5] Cookie jar')

const jar = zfsoft.createJar()
jar.absorb(['JSESSIONID=ABC123; Path=/; HttpOnly', 'csrftoken=715f39ea-47aa-468a-8acd-a440fbe68ff7; Path=/'])
check('吸收多个 cookie', jar.header(), 'JSESSIONID=ABC123; csrftoken=715f39ea-47aa-468a-8acd-a440fbe68ff7')
check('按名取值', jar.get('JSESSIONID'), 'ABC123')
jar.absorb('JSESSIONID=OVERWRITTEN; Path=/')
check('同名覆盖', jar.get('JSESSIONID'), 'OVERWRITTEN')

/* ─────────────── 结果 ─────────────── */

console.log('')
if (failed) {
  console.log('✗ ' + failed + ' 项未通过\n')
  process.exit(1)
}
console.log('✓ 全部通过\n')
