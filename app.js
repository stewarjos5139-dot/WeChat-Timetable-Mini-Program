// app.js
const config = require('./utils/config')
const cloud = require('./utils/cloud')

App({
  onLaunch() {
    // 只有走云托管才需要初始化云能力。
    // 走 BASE_URL（自建服务 / 云托管公网域名）用的是 wx.request，用不到云。
    const useCloud = !!(config.CLOUD_ENV && config.SERVICE_NAME)

    if (!useCloud) {
      if (!config.BASE_URL) {
        // 不算致命错误：本地已导入的课表、图书馆、我的都照常可用，
        // 只是「导入课表」会提示未配置。utils/config.js 里填上即可。
        console.warn('[app] 中间层地址未配置，导入课表功能不可用（见 utils/config.js）')
      }
      return
    }

    if (!wx.cloud) {
      console.error('[app] 基础库版本过低，不支持云能力，请升级到 2.2.3 以上')
      return
    }

    wx.cloud.init({
      env: config.CLOUD_ENV,
      traceUser: true
    })

    // 后台静默补传：上次离线改过课表、或上传失败过，在这里补一次。
    // 不 await、不提示，失败等下次启动 / 切回课表页再试
    cloud.ensureBackup()
  },

  globalData: {
    // 登录后写入用户信息，目前为占位
    userInfo: null
  }
})
