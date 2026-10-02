# 部署说明（自建 HTTPS 服务）

把 `server/` 部署到一台公网服务器，由 nginx 提供 HTTPS，小程序通过域名访问。

---

## 一、前置条件

三样缺一不可，微信对 request 合法域名的要求是硬性的：

| 项 | 要求 | 说明 |
|---|---|---|
| 服务器 | **国内**机房 | 只有国内服务器能办 ICP 备案 |
| 域名 | 已 **ICP 备案** | 备案通常 1-20 个工作日，**这是最长的一段等待** |
| 证书 | 受信任 CA 签发 | Let's Encrypt 免费；自签名证书微信不认 |

> 备案没下来之前，小程序**真机**连不上。但开发阶段不受影响 —— 开发者工具的
> `urlCheck` 关掉后可以直接请求 `http://localhost`，见文末「开发阶段」。

---

## 二、部署步骤

以下以 Ubuntu/Debian + nginx 为例。假设代码放在 `/opt/ilove-caida`。

### 1. 装 Node 和 nginx

```bash
# Node 18 以上（zfsoft.js 用到了全局 URL 和 crypto.randomUUID）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx

node -v   # 确认 >= 18
```

### 2. 放代码、装依赖

```bash
sudo mkdir -p /opt/ilove-caida
# 把项目里的 server/ 目录传上去（scp / git clone 都行）
sudo cp -r server /opt/ilove-caida/

cd /opt/ilove-caida/server
sudo npm install --omit=dev
```

### 3. 建一个专用系统用户

不要用 root 跑这个服务：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ilove
sudo chown -R ilove:ilove /opt/ilove-caida
```

### 4. 装 systemd 服务

```bash
sudo cp deploy/ilove-caida.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ilove-caida
sudo systemctl status ilove-caida
```

**先确认它起来了**（此时还没有 HTTPS，本机 curl 一下）：

```bash
curl -X POST http://127.0.0.1:3000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"studentId":"学号","password":"密码","xnm":"2026","xqm":"3"}'
```

看到 `{"ok":true,...}` 就说明后端本身没问题了。

### 5. 申请证书

```bash
sudo apt install -y certbot
sudo systemctl stop nginx          # certbot 首次校验要占用 80 端口
sudo certbot certonly --standalone -d your-domain.com
sudo systemctl start nginx
```

证书在 `/etc/letsencrypt/live/your-domain.com/`，90 天有效。certbot 会自动装续期定时器，`systemctl list-timers | grep certbot` 可以确认。

### 6. 配 nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/ilove-caida.conf
sudo nano /etc/nginx/conf.d/ilove-caida.conf   # 把 your-domain.com 全换掉
sudo nginx -t && sudo systemctl reload nginx
```

（Debian/Ubuntu 默认的 `sites-enabled/default` 会抢占 80 端口，记得 `sudo rm /etc/nginx/sites-enabled/default` 再 reload。）

### 7. 验证 HTTPS 通了

```bash
curl -X POST https://your-domain.com/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"studentId":"学号","password":"密码","xnm":"2026","xqm":"3"}'
```

### 8. 在小程序后台配合法域名

微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名**，填：

```
https://your-domain.com
```

（只填域名，不带路径、不带端口。）

### 9. 改小程序里的地址

`utils/api.js`：

```js
const BASE_URL = 'https://your-domain.com/api'
```

---

## 三、日常运维

```bash
sudo systemctl status ilove-caida      # 状态
sudo journalctl -u ilove-caida -f      # 实时日志
sudo systemctl restart ilove-caida     # 重启

# 改完代码后
cd /opt/ilove-caida/server && sudo npm install --omit=dev
sudo systemctl restart ilove-caida
```

---

## 四、安全注意事项

- **日志里绝不能出现密码或 `mm` 密文**。`index.js` 只记学号后四位，改代码时别破坏这一点 —— `mm` 是可直接重放登录的凭据。
- **这个服务只监听 127.0.0.1**。别改成 `0.0.0.0` 图省事绕过 nginx，那样等于把教务系统代理裸奔在公网上。
- **别做高频轮询**。教务系统很脆弱，同一账号短时间大量登录可能触发验证码或锁定。建议在服务端加一层短时缓存（同一学号 5 分钟内复用上次结果）。
- **nginx 那一层建议加限流**，防止被人拿去刷：
  ```nginx
  limit_req_zone $binary_remote_addr zone=kbcx:10m rate=10r/m;
  # 在 location /api/ 里加一行
  limit_req zone=kbcx burst=3 nodelay;
  ```

---

## 五、开发阶段（备案没下来也能联调）

开发者工具不受域名白名单限制。`project.private.config.json` 里已有 `"urlCheck": false`，所以：

1. 本机跑起后端：`cd server && node index.js`
2. `utils/api.js` 里 `BASE_URL` 保持 `http://localhost:3000/api`
3. 开发者工具里点「导入课表」，整条链路就能跑通

**注意**：这只在模拟器里有效。真机预览和发布版一律要求 HTTPS + 备案域名。
