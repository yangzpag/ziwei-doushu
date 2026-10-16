#!/usr/bin/env bash
# 本地启动 ziwei-doushu（生产模式：next build + next start）
# 注意：不要用 next dev —— 本机沙箱代理会破坏 HMR WebSocket，
# 导致 dev 模式页面 hydration 静默失败（JS 不激活、点击无反应、错误提示不显示）。
set -e

APP=/home/huanxian/code/ziwei-doushu
NODE=/home/huanxian/.nvm/versions/node/v22.23.3/bin/node
LOG=/home/huanxian/code/deploy/local/ziwei.log

cd "$APP"

# 无构建产物时自动构建（改了代码想重新构建：rm -rf .next 或设 REBUILD=1）
if [ ! -f .next/BUILD_ID ] || [ "$REBUILD" = "1" ]; then
  echo "building..."
  NODE_OPTIONS="--max-old-space-size=768" "$NODE" node_modules/next/dist/bin/next build
fi

mkdir -p "$(dirname "$LOG")"
NODE_OPTIONS="--max-old-space-size=256" exec "$NODE" node_modules/next/dist/bin/next start -p 3000 > "$LOG" 2>&1
