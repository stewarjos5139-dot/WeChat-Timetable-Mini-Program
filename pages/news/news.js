// pages/news/news.js
/** 完整资讯列表，目前为静态数据 */
const NEWS = [
  {
    id: 1,
    tag: '教务',
    title: '关于 2026 年秋季学期期末考试安排的通知',
    summary: '考试周定于第 18-19 周进行，各学院具体考场安排请登录教务系统查询。',
    source: '教务处',
    time: '2 小时前',
    tint: '#E6F7F1',
    color: '#0A8763'
  },
  {
    id: 2,
    tag: '学工',
    title: '2025-2026 学年国家奖学金申报工作启动',
    summary: '申报材料请于本月底前提交至各学院学生工作办公室，逾期不再受理。',
    source: '学生工作处',
    time: '昨天',
    tint: '#E8F1FE',
    color: '#2C6BC4'
  },
  {
    id: 3,
    tag: '后勤',
    title: '图书馆国庆假期开放时间调整公告',
    summary: '10 月 1 日至 3 日闭馆，10 月 4 日起恢复正常开放时间 8:00-22:00。',
    source: '图书馆',
    time: '2 天前',
    tint: '#FFF3E4',
    color: '#B4761F'
  },
  {
    id: 4,
    tag: '活动',
    title: '第十五届校园文化艺术节报名通道开启',
    summary: '面向全校师生，设歌唱、舞蹈、器乐、戏剧四个组别，即日起接受报名。',
    source: '校团委',
    time: '3 天前',
    tint: '#F1EDFE',
    color: '#6B5CE7'
  },
  {
    id: 5,
    tag: '就业',
    title: '2027 届毕业生秋季双选会将于本月举行',
    summary: '共有 200 余家用人单位参会，请提前准备好简历并注意着装。',
    source: '就业指导中心',
    time: '4 天前',
    tint: '#FDECF1',
    color: '#C4407A'
  },
  {
    id: 6,
    tag: '后勤',
    title: '关于校园网设备维护的通知',
    summary: '维护期间部分区域网络将短暂中断，请提前保存好正在编辑的文件。',
    source: '信息中心',
    time: '5 天前',
    tint: '#FFF8E1',
    color: '#A8861B'
  }
]

const TABS = ['全部', '教务', '学工', '后勤', '活动', '就业']

Page({
  data: {
    tabs: TABS,
    activeTab: 0,
    allNews: NEWS,
    list: NEWS
  },

  onTabChange(e) {
    const index = Number(e.currentTarget.dataset.index)
    const tab = TABS[index]
    this.setData({
      activeTab: index,
      list: index === 0 ? NEWS : NEWS.filter(item => item.tag === tab)
    })
  },

  onItemTap(e) {
    const { title } = e.currentTarget.dataset
    wx.showToast({ title, icon: 'none' })
  },

  onPullDownRefresh() {
    setTimeout(() => {
      wx.stopPullDownRefresh()
      wx.showToast({ title: '已是最新', icon: 'none' })
    }, 600)
  }
})
