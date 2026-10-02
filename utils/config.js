// utils/config.js
/**
 * 部署配置 —— 中间层怎么调，全在这一个文件里。
 *
 * 两条路二选一，**填了哪组就用哪组**（都填则优先云托管）：
 *
 * ── 路 A：微信云托管（当前采用）
 *    不需要自己的域名，也不需要 ICP 备案。
 *    CLOUD_ENV    云托管环境 ID
 *    SERVICE_NAME 创建服务时填的服务名
 *
 * ── 路 B：自建 HTTPS 服务 / 云托管的公网域名
 *    需要域名已备案（真机要求），部署步骤见 server/deploy/README.md。
 *    BASE_URL     形如 'https://your-domain.com'
 *                 注意不带 /api 后缀，请求路径由 utils/api.js 拼
 *
 * 单独放一个文件是因为 app.js 和 utils/api.js 都要用 ——
 * 各写一份迟早会改漏一处。
 */
module.exports = {
  // ── 路 A ──
  CLOUD_ENV: 'cloud1-d5gq43des7a3b241e',
  SERVICE_NAME: 'xingmeng',

  // ── 路 B ──
  BASE_URL: ''
}
