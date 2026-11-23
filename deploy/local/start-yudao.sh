#!/usr/bin/env bash
# 本地裸机启动 yudao-server（数据源 = Neon PostgreSQL，Redis = Upstash TLS）
# 用法: bash ~/.local 下的 jar 已构建后执行本脚本
set -e

JAR=/home/huanxian/code/ruoyi-vue-pro/yudao-server/target/yudao-server.jar
JAVA=/home/huanxian/.local/jdk/bin/java
LOG=/home/huanxian/code/deploy/local/yudao.log

export SPRING_PROFILES_ACTIVE=dev

# —— ziwei 模块内部接口密钥（BFF 调 consume/refund 时必须携带）——
export ZIWEI_INTERNAL_KEY=ea085a1307e1e0573e82e5e2e0cd995e4270145aee97858e

# —— 数据源：Neon PostgreSQL（US West 2，Direct 端点，强制 TLS）——
NEON_URL='jdbc:postgresql://ep-falling-base-ars1dz1m.c-4.us-west-2.aws.neon.tech/ziwei?sslmode=require'
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_URL="$NEON_URL"
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_USERNAME=neondb_owner
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_PASSWORD='npg_QtoNe8bEF4gK'
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_DRIVER_CLASS_NAME=org.postgresql.Driver
# slave 与 master 指向同一库（dev profile 有 slave 配置，懒加载但显式覆盖更稳）
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_SLAVE_URL="$NEON_URL"
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_SLAVE_USERNAME=neondb_owner
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_SLAVE_PASSWORD='npg_QtoNe8bEF4gK'
export SPRING_DATASOURCE_DYNAMIC_DATASOURCE_SLAVE_DRIVER_CLASS_NAME=org.postgresql.Driver

# —— Redis：Upstash（TLS）——
export SPRING_REDIS_HOST=relieved-scorpion-215774.upstash.io
export SPRING_REDIS_PORT=6379
export SPRING_REDIS_PASSWORD='gQAAAAAAA0reAAIgcDIzY2M5MDMwNjkxZDg0ZmVjODQ5NzBkMDIwMDIyNjY1Yw'
export SPRING_REDIS_SSL=true
export SPRING_REDIS_DATABASE=0

mkdir -p "$(dirname "$LOG")"
exec "$JAVA" -Xms128m -Xmx320m -XX:MaxMetaspaceSize=160m \
  -Djava.security.egd=file:/dev/./urandom \
  -jar "$JAR" --server.port=48080 \
  --spring.datasource.dynamic.druid.max-pool-prepared-statement-per-connection-size=0 \
  --spring.datasource.druid.max-pool-prepared-statement-per-connection-size=0 \
  > "$LOG" 2>&1
