#!/usr/bin/env bash
# 重启 yudao-server：杀旧进程 → 启动新进程
pkill -f yudao-server.jar 2>/dev/null
sleep 3
exec bash /home/huanxian/code/deploy/local/start-yudao.sh
