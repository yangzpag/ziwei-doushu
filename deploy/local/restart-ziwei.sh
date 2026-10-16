#!/usr/bin/env bash
# 重启 ziwei-doushu 生产服务：杀旧进程 → 用现有构建启动
pkill -f "next-server" 2>/dev/null
pkill -f "next start" 2>/dev/null
sleep 2
exec bash /home/huanxian/code/deploy/local/start-ziwei.sh
