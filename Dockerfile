# 构建阶段：依赖安装 + next build（需要 output: 'standalone'）
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public
RUN npm run build

# 运行阶段：只带 standalone 产物，镜像体积小
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
