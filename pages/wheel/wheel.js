// pages/wheel/wheel.js

/** 预设模板。key 是稳定标识 —— 别改也别删，改了就相当于「换了一个新模板」，
 *  老用户那边已删除的那个会被当成没种过、又冒回来。 */
const SEED_TEMPLATES = [
  { key: 'studyplay', name: '学习还是玩', options: ['学习', '玩一会儿', '先学后玩', '先玩后学'] },
  { key: 'class', name: '上课干什么', options: ['刷视频', '打游戏', '听音乐', '看小说'] },
  { key: 'weekend', name: '周末去哪玩', options: ['图书馆', '电影院', '公园', '商场', '宅家里'] },
  { key: 'sleep', name: '今晚几点睡', options: ['11 点前', '11 点半', '12 点', '1 点', '通宵'] },
  { key: 'review', name: '哪门课先复习', options: ['高数', '英语', '专业课', '思政', '不复习'] }
]

/** 本地存储的键 */
const KEY_OPTIONS = 'decision_wheel_options'
const KEY_TEMPLATES = 'decision_wheel_templates'
const KEY_CURRENT_TPL = 'decision_wheel_template_id'
const KEY_SEEDED = 'decision_wheel_seeded'

/** 转盘最小旋转圈数（增加悬念感） */
const MIN_SPINS = 5

/** 转盘缓动时长（毫秒） */
const SPIN_DURATION = 3600

/** 相邻扇形之间留的缝（度）—— 就是那条发丝分隔线，靠 .wheel 的白底透出来 */
const SLICE_GAP = 0.6

/** 中奖庆祝动画总时长（毫秒）。震动最长 0.55s、emoji 最迟 0.92s 收尾
 *  （延迟 ≤0.10s + 时长 ≤0.82s），这个值只用来决定几时把 emoji 节点摘掉。 */
const CELEBRATE_DURATION = 950

/** 屏幕抖动的时长（毫秒）。要和 wheel.wxss 里 .pad--shake 的 animation 时长一致 */
const SHAKE_DURATION = 550

/** 页面震动（整屏抖一下）。
 *  之前关过一阵，理由是「出现 emoji 时卡顿」。后来 emoji 也关掉了（ENABLE_EMOJI），
 *  那一帧没有别的合成层跟它抢，重新打开。
 *  如果再看到掉帧，把它改回 false 就行 —— 样式和关键帧都在
 *  （wheel.wxss 的 .pad--shake 和 @keyframes celebrate-shake）。 */
const ENABLE_SHAKE = true

/** 中奖 emoji 开关。
 *  关掉之后中奖只剩震动 + 标题显示结果。
 *  相关代码全部原样留着（buildCelebration、wheel.wxml 的 .celebrate 那一块、
 *  wheel.wxss 的 fall-* 关键帧），想开改回 true 就行 —— 关着的时候
 *  celebrating 永远是 false，那些节点根本不会渲染。 */
const ENABLE_EMOJI = false

/** 每侧蹦几个 */
const EMOJI_PER_SIDE = 3

/** 庆祝 emoji 池，每次随机抽 */
const EMOJI_POOL = ['🎉', '🎊', '✨', '🥳', '🎈', '⭐', '🎁', '🍀', '💫', '🏆']

/** 每条对应 wheel.wxss 里一个 @keyframes，四条的射程/抛高/旋转都不同 */
const FLING_ARCS = {
  left: ['arc-left-a', 'arc-left-b', 'arc-left-c', 'arc-left-d'],
  right: ['arc-right-a', 'arc-right-b', 'arc-right-c', 'arc-right-d']
}

/** 纵向分 4 个带（各 10%），每条弧线占一个带、带内再随机 ——
 *  纯随机会挤成一堆，这样既散得开又看不出规律。
 *  起点整体压到 36% 以下，是为了给「斜上抛」的上升段留出空间：
 *  顶点最高要抬 360rpx，再高就从屏幕顶上飞出去了。 */
const EMOJI_BANDS = [36, 46, 56, 66]

/** emoji 字号只给这三档，不做连续随机。
 *  彩色 emoji 的字形位图是按「字号」缓存的，字号一散开等于每次都要重新栅格化
 *  —— 中奖那一帧就卡在这儿。三档够看出大小变化，又基本都命中缓存。 */
const EMOJI_SIZES = [50, 62, 74]

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** 一条模板只保留 id / name / options 三个字段 */
function sanitizeTemplates(list) {
  return list.filter(function (t) {
    return t && t.id && t.name && Array.isArray(t.options)
  }).map(function (t) {
    return {
      id: t.id,
      name: t.name,
      // 空选项是合法的（「＋」新建出来就是空的），但里面不能混进脏东西
      options: t.options.filter(function (o) {
        return typeof o === 'string' && o
      }).slice(0, 8)
    }
  })
}

/**
 * 读模板列表，顺便把还没种过的预设补进来。
 *
 * 记的是「种过哪些预设」，不是「种到第几版」—— 按版本补的话，老用户删掉的
 * 预设会在下次加预设时被当成新的塞回来。按 key 记就不会：删了就是删了。
 */
function loadTemplates() {
  let saved = null
  let seeded = []
  try {
    saved = wx.getStorageSync(KEY_TEMPLATES)
    seeded = wx.getStorageSync(KEY_SEEDED)
  } catch (e) {
    saved = null
    seeded = []
  }
  if (!Array.isArray(seeded)) seeded = []

  const list = Array.isArray(saved) ? sanitizeTemplates(saved) : []
  const names = list.map(function (t) { return t.name })
  let changed = !Array.isArray(saved)

  SEED_TEMPLATES.forEach(function (t) {
    const id = 'seed-' + t.key
    if (seeded.indexOf(id) >= 0) return
    seeded.push(id)
    // 同名的已经有了就跳过。老版本用下标做 id（seed-0），升级上来跟 key 对不上，
    // 不拦一下会把 5 个预设全部重塞一遍，列表里出现两份「今天吃什么」。
    if (names.indexOf(t.name) < 0) {
      list.push({ id: id, name: t.name, options: t.options.slice() })
      names.push(t.name)
    }
    changed = true
  })

  if (changed) {
    saveTemplates(list)
    try {
      wx.setStorageSync(KEY_SEEDED, seeded)
    } catch (e) {
      // 静默失败
    }
  }

  return list
}

function saveTemplates(list) {
  try {
    wx.setStorageSync(KEY_TEMPLATES, list)
  } catch (e) {
    // 静默失败
  }
}

function newTemplateId() {
  return 'tpl-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
}

/**
 * 生成这一轮要用的 emoji。
 * 位置、大小、延迟、时长、弧线、字符全随机 —— 不随机的话连转两次会发现
 * 画面一模一样，一眼假。每侧还固定占满 4 个高度带，保证散得开。
 */
function buildCelebration() {
  const list = []
  const sides = ['left', 'right']

  sides.forEach(function (side) {
    const arcs = FLING_ARCS[side]
    // 打乱高度带的分配，免得每次都固定第一条在最上面
    const bands = EMOJI_BANDS.slice().sort(function () { return Math.random() - 0.5 })

    for (let i = 0; i < EMOJI_PER_SIDE; i++) {
      // 时长/延迟走内联，弧线（animation-name）留在 class 里
      const style = 'top:' + (bands[i] + randInt(0, 9)) + '%;' +
        'font-size:' + EMOJI_SIZES[randInt(0, EMOJI_SIZES.length - 1)] + 'rpx;' +
        'animation-duration:' + (randInt(680, 820) / 1000).toFixed(3) + 's;' +
        'animation-delay:' + (randInt(0, 100) / 1000).toFixed(3) + 's'

      list.push({
        id: side + '-' + i,
        char: EMOJI_POOL[randInt(0, EMOJI_POOL.length - 1)],
        side: side,
        arc: arcs[randInt(0, arcs.length - 1)],
        style: style
      })
    }
  })

  return list
}

Page({
  data: {
    templates: [], // 全部模板，首次打开时由 loadTemplates 把内置的种进去
    currentTpl: null, // 当前选中的模板；为 null 时底部只显示「存储为模板」
    templateName: '', // 转盘上方标题用
    options: [], // { text: string, angle: number }[]
    inputText: '',
    editingIndex: -1, // 正在就地改哪一行的选项，-1 = 没有
    editText: '', // 那一行的草稿值
    rotation: 0, // 当前转盘旋转角度
    spinning: false,
    result: '', // 当前选中结果
    celebrating: false, // 中奖瞬间的 emoji 庆祝，跑完自动关掉（开关见 ENABLE_EMOJI）
    celebration: [], // 这一轮的 emoji 列表，中奖时才由 buildCelebration 生成
    shaking: false // 中奖瞬间的整屏抖（开关见 ENABLE_SHAKE）
  },

  onLoad() {
    const templates = loadTemplates()
    this.setData({ templates: templates })

    // 恢复上次选中的模板
    try {
      const tplId = wx.getStorageSync(KEY_CURRENT_TPL)
      if (tplId) {
        for (let i = 0; i < templates.length; i++) {
          if (templates[i].id === tplId) {
            this.setCurrentTemplate(templates[i])
            break
          }
        }
      }
    } catch (e) {
      // 静默失败
    }

    // 从本地恢复上次的选项
    try {
      const saved = wx.getStorageSync(KEY_OPTIONS)
      if (Array.isArray(saved) && saved.length) {
        this.setOptions(saved.map(t => t.text || t).slice(0, 8))
      }
    } catch (e) {
      // 静默失败
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value })
  },

  onAdd() {
    const text = this.data.inputText.trim()
    if (!text) {
      wx.showToast({ title: '请输入选项内容', icon: 'none' })
      return
    }
    if (this.data.options.length >= 8) {
      wx.showToast({ title: '最多 8 个选项', icon: 'none' })
      return
    }

    // 倒序插入：新加的排在最前面，紧贴输入框下方
    const newOptions = [text].concat(this.data.options.map(o => o.text))
    this.setOptions(newOptions)
    this.setData({ inputText: '', result: '', editingIndex: -1, editText: '' })
    this.saveOptions()
  },

  onDeleteOption(e) {
    const index = Number(e.currentTarget.dataset.index)
    const newOptions = this.data.options.filter((_, i) => i !== index).map(o => o.text)
    this.setOptions(newOptions)
    // 删完下标会整体前移，编辑态直接关掉，免得改到隔壁那一行
    this.setData({ result: '', editingIndex: -1, editText: '' })
    this.saveOptions()
  },

  /** 点某一行的文字 = 就地改。再用那个「删除后重新添加」的老办法太绕了 */
  onEditOption(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (this.data.editingIndex === index) return

    const opt = this.data.options[index]
    this.setData({
      editingIndex: index,
      editText: opt ? opt.text : ''
    })
  },

  onEditInput(e) {
    this.setData({ editText: e.detail.value })
  },

  /**
   * 收尾。confirm 和 blur 都会走到这儿，所以必须幂等 ——
   * 先到的那次把 editingIndex 清成 -1，后到的那次直接返回。
   * 下标也从事件里取，防止「点到另一行」时把新行的草稿当成旧行的提交。
   */
  onEditCommit(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (index !== this.data.editingIndex) return

    const text = this.data.editText.trim()
    this.setData({ editingIndex: -1, editText: '' })

    if (!text) return // 清空当没改过，保持原样

    const options = this.data.options.map(function (o) { return o.text })
    options[index] = text.slice(0, 12)
    this.setOptions(options)
    this.saveOptions()
  },

  /** 点模板 = 选中并装填；再点一次取消选中 —— 不然回不到「存储为模板」那一档 */
  onTemplate(e) {
    const id = e.currentTarget.dataset.id
    const tpl = this.findTemplate(id)
    if (!tpl) return

    if (this.data.currentTpl && this.data.currentTpl.id === id) {
      this.setCurrentTemplate(null)
      return
    }

    this.setOptions(tpl.options)
    this.setCurrentTemplate(tpl)
    this.setData({ result: '', rotation: 0, inputText: '', editingIndex: -1, editText: '' })
    this.saveOptions()
    wx.showToast({ title: `已装填「${tpl.name}」`, icon: 'none' })
  },

  /**
   * 模板排末尾的「＋」：先起名，再建一个空模板并直接选中它。
   * 接下来往盘里加的每一个选项都算这个模板的，加完点「保存修改」落盘。
   * 所以盘上的旧选项会被清掉 —— 和「选中模板就装填它的选项」保持一套逻辑。
   */
  onNewTemplate() {
    wx.showModal({
      title: '新建模板',
      editable: true,
      placeholderText: '给模板起个名字',
      confirmText: '创建',
      confirmColor: '#2F4A8A',
      success: res => {
        if (!res.confirm) return
        const name = (res.content || '').trim().slice(0, 12)
        if (!name) {
          wx.showToast({ title: '名字不能为空', icon: 'none' })
          return
        }

        const tpl = { id: newTemplateId(), name: name, options: [] }
        const list = this.data.templates.concat([tpl])
        saveTemplates(list)

        this.setOptions([])
        this.setCurrentTemplate(tpl)
        this.setData({ templates: list, result: '', rotation: 0, inputText: '', editingIndex: -1, editText: '' })
        this.saveOptions()
        wx.showToast({ title: '模板已创建，开始加选项吧', icon: 'none' })
      }
    })
  },

  /**
   * 存为新模板。名字用 showModal 的 editable 输入框要 ——
   * 自带键盘和确认键，比再做一个底部弹层省事得多。
   */
  onSaveTemplate() {
    if (!this.data.options.length) {
      wx.showToast({ title: '先添加几个选项', icon: 'none' })
      return
    }

    wx.showModal({
      title: '存为模板',
      editable: true,
      placeholderText: '给这组选项起个名字',
      confirmText: '保存',
      confirmColor: '#2F4A8A',
      success: res => {
        if (!res.confirm) return
        const name = (res.content || '').trim().slice(0, 12)
        if (!name) {
          wx.showToast({ title: '名字不能为空', icon: 'none' })
          return
        }

        const tpl = {
          id: newTemplateId(),
          name: name,
          options: this.data.options.map(function (o) { return o.text })
        }
        const list = this.data.templates.concat([tpl])
        saveTemplates(list)
        this.setData({ templates: list })
        this.setCurrentTemplate(tpl)
        wx.showToast({ title: '已存为模板', icon: 'success' })
      }
    })
  },

  /** 把盘上当前的选项写回选中的模板 */
  onUpdateTemplate() {
    const cur = this.data.currentTpl
    if (!cur) return

    const options = this.data.options.map(function (o) { return o.text })
    const list = this.data.templates.map(function (t) {
      return t.id === cur.id ? { id: t.id, name: t.name, options: options } : t
    })
    saveTemplates(list)
    // currentTpl 也要换成新快照，不然它还指着旧的 options
    this.setData({ templates: list, editingIndex: -1, editText: '' })
    this.setCurrentTemplate({ id: cur.id, name: cur.name, options: options })
    wx.showToast({ title: '模板已更新', icon: 'success' })
  },

  /** 删掉选中的模板。模板和盘上的选项是一体的，一起清掉 */
  onDeleteTemplate() {
    const cur = this.data.currentTpl
    if (!cur) return

    wx.showModal({
      title: '删除模板',
      content: '确定删除「' + cur.name + '」？转盘上的选项也会一起清掉。',
      confirmText: '删除',
      confirmColor: '#B3402F',
      success: res => {
        if (!res.confirm) return
        const list = this.data.templates.filter(function (t) { return t.id !== cur.id })
        saveTemplates(list)

        // 先断关联再更新列表，避免中间态里还指着已删的模板
        this.setCurrentTemplate(null)
        this.setOptions([])
        this.setData({ templates: list, result: '', rotation: 0, editingIndex: -1, editText: '' })
        this.saveOptions()
        wx.showToast({ title: '模板已删除', icon: 'none' })
      }
    })
  },

  findTemplate(id) {
    const all = this.data.templates
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i]
    }
    return null
  },

  /** currentTpl 和 templateName 永远一起变，收在一个地方 */
  setCurrentTemplate(tpl) {
    this.setData({
      currentTpl: tpl,
      templateName: tpl ? tpl.name : ''
    })
    try {
      wx.setStorageSync(KEY_CURRENT_TPL, tpl ? tpl.id : '')
    } catch (e) {
      // 静默失败
    }
  },

  /**
   * 核心：转盘动画
   * 1. 随机选一个目标选项
   * 2. 计算让指针指向它需要的旋转角度（加上多圈增加悬念）
   * 3. 用 CSS transition 缓动过去
   * 4. 动画结束后震动反馈 + 显示结果
   */
  onSpin() {
    if (this.data.spinning) return
    if (this.data.options.length < 2) {
      wx.showToast({ title: '至少需要 2 个选项', icon: 'none' })
      return
    }

    // 上一轮的手势反馈还没收尾就再转：先把旧计时器掐掉，
    // 否则它到点会把这一轮的动画提前关掉
    if (this.celebrateTimer) {
      clearTimeout(this.celebrateTimer)
      this.celebrateTimer = null
    }
    if (this.shakeTimer) {
      clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }

    const options = this.data.options
    const count = options.length
    const anglePerSlice = 360 / count

    // 随机选一个
    const winnerIndex = Math.floor(Math.random() * count)
    const winner = options[winnerIndex]

    // 扇形 i 覆盖 [i·θ, (i+1)·θ]。指针固定在 12 点（0°），所以要让落点转到 0°，
    // 转盘的绝对角度得是「-落点」—— 注意是「绝对」角度，不是本次要转多少。
    //
    // 落点在扇形里随机取，不取正中：每次都精准停在正中间，一眼就看得出是摆好的。
    // 两边各留 15% 边距 —— 紧贴着分界线停会让「这到底算哪一格」变得含糊。
    const margin = anglePerSlice * 0.15
    const landAngle = winner.angle + margin + Math.random() * (anglePerSlice - margin * 2)
    const targetMod = ((360 - landAngle) % 360 + 360) % 360

    // 按当前绝对角度算增量。早先是直接累加 -sliceCenterAngle，
    // 那只在第一次（rotation 从 0 出发）碰巧对；第二次起会带着上一次的
    // 偏差继续转，指针指的和报的就不是同一格了。
    const current = this.data.rotation
    const currentMod = ((current % 360) + 360) % 360
    let delta = targetMod - currentMod
    if (delta < 0) delta += 360

    // 多转几圈加悬念。必须是整数圈 —— 带小数的话那零点几圈会变成
    // 几十上百度的额外偏移，指针停的格子就和抽中的对不上了。
    const extraRotation = (MIN_SPINS + Math.floor(Math.random() * 3)) * 360
    const targetRotation = current + delta + extraRotation

    this.setData({
      spinning: true,
      result: '',
      // 上一轮的反馈立刻收掉，别一直挂到这一轮转完
      celebrating: false,
      shaking: false
    })

    // 延迟一帧触发动画
    setTimeout(() => {
      this.setData({ rotation: targetRotation })
    }, 50)

    // 动画结束：震动 + 屏幕抖 + emoji + 显示结果。后两样各有各的开关
    setTimeout(() => {
      wx.vibrateShort({ type: 'medium' })

      const patch = { spinning: false, result: winner.text }
      if (ENABLE_SHAKE) patch.shaking = true
      if (ENABLE_EMOJI) {
        patch.celebrating = true
        patch.celebration = buildCelebration()
      }
      this.setData(patch)

      // 各跑各的时长，到点各自收掉。
      // 抖动的类必须摘干净 —— 不摘的话下次中奖类名没变化，CSS 动画不会再触发
      if (ENABLE_SHAKE) {
        this.shakeTimer = setTimeout(() => {
          this.shakeTimer = null
          this.setData({ shaking: false })
        }, SHAKE_DURATION)
      }
      if (ENABLE_EMOJI) {
        this.celebrateTimer = setTimeout(() => {
          this.celebrateTimer = null
          this.setData({ celebrating: false })
        }, CELEBRATE_DURATION)
      }
    }, SPIN_DURATION + 100)
  },

  onUnload() {
    if (this.celebrateTimer) clearTimeout(this.celebrateTimer)
    if (this.shakeTimer) clearTimeout(this.shakeTimer)
  },

  /**
   * 装填选项：均分 360°，角度一律「从 12 点起顺时针」，
   * 和 CSS 的 rotate 方向、指针位置（12 点）对齐。
   */
  setOptions(texts) {
    const count = texts.length
    if (!count) {
      this.setData({ options: [] })
      return
    }

    const anglePerSlice = 360 / count
    // 扇形靠两层半平面裁出来，单个最大只能到 180°
    // —— 只有一个选项时干脆不裁，整盘一个色
    const full = count === 1

    const options = texts.map((text, i) => {
      const startAngle = i * anglePerSlice

      // 第二刀的旋转角：半平面本来覆盖 [0°, 180°]，
      // 转 (θ-180°) 后落到 [θ-180°, θ]；再少转 SLICE_GAP 就留出缝
      const wedgeStyle = full
        ? ''
        : 'transform: rotate(' + (anglePerSlice - SLICE_GAP - 180) + 'deg)'

      // 文字沿半径向外：slice-content 不转时指向本地 90°（3 点方向），
      // 减 90° 归零到 12 点，再加半个扇形到中线
      const textAngle = anglePerSlice / 2 - 90

      return {
        text: text,
        angle: startAngle,
        wedgeStyle: wedgeStyle,
        textAngle: textAngle,
        fullClass: full ? 'slice--full' : ''
      }
    })

    this.setData({ options: options })
  },

  saveOptions() {
    try {
      wx.setStorageSync(KEY_OPTIONS, this.data.options.map(o => o.text))
    } catch (e) {
      // 静默失败
    }
  }
})
