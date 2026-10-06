FROM node:22-alpine
LABEL org.opencontainers.image.title="caremate-api"
LABEL org.opencontainers.image.description="CareMate AI API — 口述轉結構化照護任務（含印尼文/越南文翻譯）"

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.mjs"]
