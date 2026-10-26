FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4090 \
    WENRONG_DB=/app/data/wenrong.sqlite

COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

RUN mkdir -p /app/data \
    && addgroup -S -g 10001 wenrong \
    && adduser -S -D -H -u 10001 -G wenrong wenrong \
    && chown -R wenrong:wenrong /app

# 非 root 运行；data 目录由该用户持有（SQLite 文件写入）
USER wenrong

EXPOSE 4090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
