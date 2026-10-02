// utils/parser.js
/**
 * 正方教务系统课表解析。
 *
 * 输入是 xskbcx_cxXsKb.html 返回 JSON 里的 kbList 数组，输出是本项目课表页
 * 使用的课程结构。解析放在小程序端而不是后端，是为了学校改格式时能只发版
 * 小程序、不用动服务端。
 *
 * kbList 单项的常见字段：
 *   kcmc  课程名称      jxbmc 教学班名称
 *   xqj   星期几 1-7    jcs   节次，如 "1-2"
 *   zcd   周次，如 "1-16周" / "1-8周(单)"
 *   cdmc  上课地点      xm    教师姓名
 */

/** 配色数量，与课表页 PALETTE 的长度保持一致 */
const COLOR_COUNT = 5

/**
 * 节次 → 起始节与节数。
 * "1-2" → { start: 1, span: 2 }；"3" → { start: 3, span: 1 }
 */
function parseJcs(jcs) {
  if (jcs === undefined || jcs === null || jcs === '') return null

  const nums = String(jcs).match(/\d+/g)
  if (!nums || !nums.length) return null

  const list = nums.map(function (n) { return parseInt(n, 10) }).filter(function (n) { return n > 0 })
  if (!list.length) return null

  const start = Math.min.apply(null, list)
  const end = Math.max.apply(null, list)
  return { start: start, span: end - start + 1 }
}

/**
 * 周次 → { weeks: [起, 止], parity }。
 * "1-16周" → [[1,16], 'all']；"1-8周(单)" → [[1,8], 'odd']
 *
 * 局限：只支持连续区间。像 "1,3,5周" 这种离散周次会被当成 1-5 周处理，
 * 正方默认的 "1-16周(单)" 形式不受影响。
 */
function parseZcd(zcd) {
  if (!zcd) return null

  const text = String(zcd)
  let parity = 'all'
  if (/[(（]\s*单\s*[)）]/.test(text)) parity = 'odd'
  else if (/[(（]\s*双\s*[)）]/.test(text)) parity = 'even'

  const nums = text.match(/\d+/g)
  if (!nums || !nums.length) return null

  const list = nums.map(function (n) { return parseInt(n, 10) })
  const from = Math.min.apply(null, list)
  const to = Math.max.apply(null, list)
  return { weeks: [from, to], parity: parity }
}

/** 去掉字符串首尾空白，空值给个占位 */
function text(value, fallback) {
  const s = (value === undefined || value === null) ? '' : String(value).trim()
  return s || fallback
}

/**
 * 解析 kbList。
 * @param {Array} kbList 教务系统返回的原始数组
 * @param {Object} [options] { totalWeeks } 周次解析失败时的兜底范围
 * @returns {Array} 课程数组，按星期与节次排好序
 */
function parseKbList(kbList, options) {
  if (!Array.isArray(kbList)) return []

  const totalWeeks = (options && options.totalWeeks) || 20
  const colorByName = {} // 同一门课固定同一个配色
  let colorCursor = 0
  const courses = []

  kbList.forEach(function (raw, index) {
    if (!raw || typeof raw !== 'object') return

    const name = text(raw.kcmc, '')
    if (!name) return

    const day = parseInt(raw.xqj, 10)
    if (!(day >= 1 && day <= 7)) return

    const slot = parseJcs(raw.jcs)
    if (!slot) return

    const weeks = parseZcd(raw.zcd) || { weeks: [1, totalWeeks], parity: 'all' }

    if (colorByName[name] === undefined) {
      colorByName[name] = colorCursor % COLOR_COUNT
      colorCursor += 1
    }

    courses.push({
      // jxbmc 是教学班名，同一门课不同班次不会撞 id；缺失时退回下标
      id: text(raw.jxbmc, 'kb-' + index) + '-' + index,
      name: name,
      teacher: text(raw.xm, '未知'),
      room: text(raw.cdmc, '待定'),
      day: day,
      start: slot.start,
      span: slot.span,
      weeks: weeks.weeks,
      parity: weeks.parity === 'all' ? undefined : weeks.parity,
      color: colorByName[name]
    })
  })

  // 按星期、再按起始节排序，展示更稳
  courses.sort(function (a, b) {
    if (a.day !== b.day) return a.day - b.day
    return a.start - b.start
  })

  return courses
}

/**
 * 粗略校验一份解析结果像不像正常课表，用于导入后给用户一个反馈。
 */
function summarize(courses) {
  const names = {}
  courses.forEach(function (c) { names[c.name] = true })
  return {
    slots: courses.length, // 课程块数量
    courses: Object.keys(names).length // 去重后的课程门数
  }
}

module.exports = {
  parseJcs: parseJcs,
  parseZcd: parseZcd,
  parseKbList: parseKbList,
  summarize: summarize
}
