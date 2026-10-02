// server/try.js
/**
 * 联调入口。直接调 fetchSchedule，绕开 curl 在 Windows CMD 下的引号问题。
 *
 * 两种用法：
 *   1. node try.js <学号> <密码> [学年] [学期]
 *   2. 在 server/.local.json 写 {"studentId":"...","password":"..."} 然后直接 node try.js
 *
 * 密码带 ! 等特殊字符时用第二种 —— 命令行传参可能被 shell 吃掉字符。
 *
 * 加 ZF_DEBUG=1 会打印每一步的细节，用来和浏览器抓包逐字段对比：
 *   set ZF_DEBUG=1 && node try.js ...
 */

const fs = require('fs')
const path = require('path')
const { fetchSchedule } = require('./zfsoft')
const parser = require('../utils/parser')

/* ── 凭据来源：命令行优先，其次 .local.json ── */

let local = {}
const localPath = path.join(__dirname, '.local.json')

if (fs.existsSync(localPath)) {
  try {
    local = JSON.parse(fs.readFileSync(localPath, 'utf8'))
  } catch (err) {
    console.log('⚠️ .local.json 解析失败：' + err.message)
  }
}

const args = process.argv.slice(2)
const studentId = args[0] || local.studentId
const password = args[1] || local.password
const xnm = args[2] || local.xnm || '2026'
const xqm = args[3] || local.xqm || '3'

if (!studentId || !password) {
  console.log('用法一：node try.js <学号> <密码> [学年] [学期]')
  console.log('用法二：在 server/.local.json 里写：')
  console.log('        {"studentId":"你的学号","password":"你的密码","xnm":"2026","xqm":"3"}')
  console.log('        然后直接 node try.js')
  console.log('')
  console.log('密码含 ! 等特殊字符时推荐用法二，命令行可能被 shell 吃掉字符。')
  process.exit(1)
}

console.log('正在登录 xk.huel.edu.cn ...')
console.log('  学号 ' + studentId + ' / 学年 ' + xnm + ' / 学期 ' + xqm)

// 打码显示密码，重点是看长度对不对 —— 能一眼发现被 shell 吃掉的字符
const masked = password.length > 2
  ? password.charAt(0) + '*'.repeat(password.length - 2) + password.charAt(password.length - 1)
  : '**'
console.log('  密码 ' + password.length + ' 位：' + masked +
  (args[1] ? '（来自命令行）' : '（来自 .local.json）'))
console.log('')

/* ── 跑 ── */

fetchSchedule({ studentId, password, xnm, xqm })
  .then(function (data) {
    console.log('✓ 登录成功')
    console.log('  学生：' + (data.studentName || '（接口未返回姓名）'))
    console.log('  kbList 条数：' + data.kbList.length + '\n')

    console.log('── 原始数据前 3 条（只挑关键字段）──')
    console.log(JSON.stringify(data.kbList.slice(0, 3).map(function (item) {
      return {
        kcmc: item.kcmc, xqj: item.xqj, jcs: item.jcs, zcd: item.zcd,
        cdmc: item.cdmc, xm: item.xm, jxbmc: item.jxbmc
      }
    }), null, 2))

    const courses = parser.parseKbList(data.kbList, { totalWeeks: 20 })
    const stat = parser.summarize(courses)

    console.log('\n── 解析结果 ──')
    console.log(stat.courses + ' 门课 / ' + stat.slots + ' 个课块')

    if (!courses.length) {
      console.log('⚠️ 一条都没解析出来。多半是字段名对不上，看上面的原始数据。')
      return
    }

    // 节次范围必须落在课表页的 13 节之内，超出的会被静默丢弃
    const maxSection = courses.reduce(function (m, c) {
      return Math.max(m, c.start + c.span - 1)
    }, 0)
    const days = {}
    courses.forEach(function (c) { days[c.day] = true })
    console.log('  节次范围 1-' + maxSection + ' / 覆盖星期 ' +
      Object.keys(days).sort().join(',') + '（1=周一）')
    if (maxSection > 13) {
      console.log('  ⚠️ 最大节次 ' + maxSection + ' 超过课表页的 13 节，这些课会显示不出来')
    }

    console.log('\n前 3 个课块：')
    console.log(JSON.stringify(courses.slice(0, 3), null, 2))
    console.log('\n■ 整条链路通了。这是对后端本身的验证，部署步骤见 deploy/cloud-hosting.md。')
  })
  .catch(function (err) {
    console.log('✗ 失败：' + ((err && err.message) || err))
    if (!process.env.ZF_DEBUG) {
      console.log('\n提示：加 ZF_DEBUG=1 再跑一次可以看到每一步的细节。')
      console.log('      Windows CMD:  set ZF_DEBUG=1 && node try.js ...')
    }
    process.exit(1)
  })
