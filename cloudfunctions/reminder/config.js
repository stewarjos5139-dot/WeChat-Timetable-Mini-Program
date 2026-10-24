/**
 * 上课提醒的配置。**改完要重新上传云函数才生效。**
 *
 * 当前选用的模板：「日程提醒」（模板编号 17406，类目：信息查询）
 * 部署步骤见根目录《订阅消息提醒.md》。
 */

module.exports = {
  /* ── 订阅消息模板 ──
   * 小程序端 utils/config.js 的 SUBSCRIBE_TEMPLATE_ID 必须填同一个值。
   */
  TEMPLATE_ID: 'rjv74W5NzMSCLvxq-knJ9ww5FuEMf44xxf-0-wr-aUo',

  /**
   * 订阅类型：
   *   'once' 一次性订阅 —— 用户点一次换一条消息，靠客户端攒额度
   *   'long' 长期订阅   —— 授权一次长期有效，不攒额度也不扣次数
   * 公众平台里能看到「长期订阅」模板就用 'long'。
   */
  MODE: 'once',

  /* 上课前几分钟提醒（用户没设置时的缺省值） */
  LEAD_MINUTES: 20,

  /*
   * 允许用户选择的提前量（分钟）。客户端 utils/reminder.js 的 LEAD_OPTIONS
   * 必须与这里完全一致；定时器的「是否到点」判断也按这个全集来算。
   */
  ALLOWED_LEAD_MINUTES: [5, 10, 15, 20, 30, 45, 60],

  /*
   * 一次点击最多能换多少条额度。微信规定一次点击只能发起一次订阅授权、
   * 一次授权 = 一条消息，所以这里是 1（与客户端 utils/reminder.js 的 MAX_PER_TAP 一致）。
   */
  MAX_QUOTA_PER_TAP: 1,

  /* 额度上限，防止客户端把数字报到离谱 */
  MAX_QUOTA: 50,

  /**
   * 消息点开后跳到哪一页。
   * 调试期把 MINIPROGRAM_STATE 改成 'developer'，否则预览版收不到可跳转的消息。
   * 取值：'developer' | 'trial' | 'formal'
   */
  PAGE: 'pages/schedule/schedule',
  MINIPROGRAM_STATE: 'formal',

  /* ── 模板字段映射 ──
   * 「日程提醒」模板的五个字段：
   *   距离开始时间 short_thing18   课程名称 thing8   教师 thing14
   *   时间 time3                   地点 thing4
   * 换模板时按新模板的关键词改这里；模板里没有的字段留空字符串即可。
   */
  FIELDS: {
    countdown: 'short_thing18', // 距离开始时间，short_thing 限 5 个字符
    course: 'thing8',           // 课程名称，thing 限 20 个字符
    teacher: 'thing14',         // 教师
    time: 'time3',              // 时间，time 型：2026年10月24日 08:00
    room: 'thing4'              // 地点
  },

  /**
   * time 字段的格式。不同模板要求不一样：
   *   'datetime' → 2026年10月24日 08:00
   *   'date'     → 2026年10月24日
   *   'time'     → 08:00
   * 模板校验不通过会在发送时报错，按错误提示改这里。
   */
  TIME_FORMAT: 'datetime',

  /**
   * 距离开始时间的文案，{lead} 会替换成 LEAD_MINUTES。
   * short_thing 限 5 个字符，「20分钟」正好 4 个 —— 别写「还有 20 分钟上课」。
   */
  TIP_TEXT: '{lead}分钟',

  /* 集合名 */
  COLLECTIONS: {
    reminders: 'reminders',
    schedules: 'schedules'
  }
}
