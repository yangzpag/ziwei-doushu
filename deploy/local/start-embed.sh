#!/bin/bash
# 中医知识库 embedding 微服务（bge-small-zh-v1.5，端口 3001）
# 首次启动自动从 hf-mirror 下载模型（~48MB）并缓存到 ~/.cache/huggingface。
# 挂掉不影响主站：BFF 检索自动降级为关键词模式。
set -e
cd /home/huanxian/code/ziwei-doushu
export PATH=/home/huanxian/.nvm/versions/node/v22.23.3/bin:$PATH
exec node scripts/embed-server.mjs
