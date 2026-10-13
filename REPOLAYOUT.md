# 仓库布局（REPOLAYOUT）

> 本文档描述 ziwei-doushu 的目录结构与数据流。**大改动（新增模块/目录/接口族）后必须同步更新本文档。**

## 技术栈

- Next.js 16（App Router，Turbopack 构建，`output: standalone`）
- React 19.2（锁定版本，勿升 19.3+）、`@anthropic-ai/sdk` ≥0.133
- 排盘内核：`lib/ziwei/*`（纯 TypeScript，无框架依赖，8 个回归测试保护）
- 后端：ruoyi-vue-pro（Java，`/app-api/*`），本仓库通过 BFF 路由代理

## 目录结构

```
app/
  page.tsx                 # V2 首页（TopBar + Hero 表单 + 最近命盘 + 板块卡）
  chart/page.tsx           # 排盘结果页（V2：六层推演 + AI 常驻侧栏）
  heming/                  # 合盘
  knowledge/               # 中医知识库（SSG）
  library/                 # 古籍库（SSG + 搜索）
  login/  profile/         # 登录注册 / 个人中心（命盘列表）
  profile/charts/[id]/     # 保存的命盘回放页
  api/
    auth/                  # 登录/注册/登出/me（BFF，token 只存 httpOnly cookie）
    ziwei/                 # 权益 BFF：points（余额）、chart（保存/列表/详情/删除）
      _session.ts          # BFF 会话辅助（401/503 语义约定，见 CODESTYLE）
    interpret/             # AI 对话（SSE 流式，扣次数/失败退还）
  middleware.ts            # 保护 /profile（未登录 302 → /login?next=）
components/
  v2/                      # V2 改版组件（TopBar/ChartGridV2/AiSidePanel/BirthForm 复用）
  BirthForm.tsx            # 出生信息表单（首页/排盘页共用）
  ChartBoard.tsx           # 命盘棋盘（回放页复用）
  ChatPanel.tsx            # 开源版 AI 面板（当前未挂载，SSE 读取逻辑参考 AiSidePanel）
  UserNav.tsx              # 全站用户入口（登录态感知，variant: float/inline）
lib/
  ziwei/                   # 排盘引擎（算法/常量/类型/layers 六层推演）
  auth.ts                  # 服务端 cookie 会话（getValidSession：ok/unauthenticated/invalid/transient_error）
  yudao.ts                 # Java API 客户端（token/tenant-id/自定义 headers）
scripts/regression/        # 排盘回归测试（8 个，`pnpm test` 必须全绿才能合并）
sql/
  postgresql/ziwei.sql     # 权益模块表结构（PG，幂等脚本）
  mysql/ziwei.sql          # 同结构 MySQL 版
```

## 数据流与信任边界

```
浏览器 ──cookie──▶ Next.js BFF（app/api/*）
                      │  ├─ 会话：lib/auth.ts（accessToken/refreshToken 存 httpOnly）
                      │  ├─ 读操作：携带用户 token 调 Java /app-api/*
                      │  └─ 写操作（次数扣/退）：调 Java 内部接口 + X-Internal-Key
                      ▼
                 ruoyi-vue-pro (Java:48080) ──▶ PostgreSQL（Neon）
```

- **写操作不对最终用户暴露**：次数 consume/refund 在 Java 侧是 `/ziwei/points/internal/*`（X-Internal-Key 共享密钥）。BFF 是唯一持有密钥方。
- **会话语义**（所有 BFF 路由遵守）：未登录 → HTTP 401（前端引导登录）；上游抖动 → 503（前端显示重试，不得误导为游客）；yudao 业务错误 → 400 + message。

## 相关文档

- `CODESTYLE.md`：代码风格与提交前自审清单
- 根目录 `PLAN.md`（本地）：项目阶段计划与踩坑记录
