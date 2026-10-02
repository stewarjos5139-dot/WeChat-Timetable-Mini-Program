# ilove财大 中间层 —— 微信云托管容器
#
# 云托管跑的是标准 Node 容器，server/index.js 原样可用，不需要改造成云函数。

FROM node:20-slim

WORKDIR /app

# 先装依赖再拷源码，这样改代码不会让依赖层缓存失效
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ⚠️ 关键：server/index.js 里 HOST 默认是 127.0.0.1。
# 那是为「自建 + nginx 反代」设计的默认值（故意 fail-closed，防止忘了配 nginx
# 时服务裸奔到公网）。容器里必须覆盖成 0.0.0.0，否则外部连不进来。
ENV HOST=0.0.0.0
# 端口要和云托管控制台里配置的容器端口一致
ENV PORT=80
ENV NODE_ENV=production

EXPOSE 80

CMD ["node", "index.js"]
