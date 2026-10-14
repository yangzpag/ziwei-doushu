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
    zhongyi/               # 中医知识库 BFF：books（六部统计）/ ask（语义检索）/ outline（课程大纲）
  middleware.ts            # 保护 /profile（未登录 302 → /login?next=）
app/
  zhongyi/                 # 中医知识库页面：page（首页：搜索+六部卡片）、[book]（课程问答）
components/
  v2/                      # V2 改版组件（TopBar/ChartGridV2/AiSidePanel/BirthForm 复用）
  zhongyi/                 # 知识库组件：KbHome（首页）、CourseChat（问答/引用/历史/大纲）、zhongyi.module.css
  BirthForm.tsx            # 出生信息表单（首页/排盘页共用）
  ChartBoard.tsx           # 命盘棋盘（回放页复用）
  ChatPanel.tsx            # 开源版 AI 面板（当前未挂载，SSE 读取逻辑参考 AiSidePanel）
  UserNav.tsx              # 全站用户入口（登录态感知，variant: float/inline）
lib/
  ziwei/                   # 排盘引擎（算法/常量/类型/layers 六层推演）
  corpus/                  # 中医知识库语料：books（六部元数据）、pg（PG 池）、search（向量+关键词检索）
  vk/                      # 通用视频知识流水线（字幕/摘录 → 知识卡片），见 docs/video-kb-pipeline.md
    types.ts timeline.ts   # 核心类型 / 时间轴与 B 站链接（程序计算，禁编造）
    adapters/              # SRT/VTT/字幕JSON/摘录JSONL 适配器 + 格式探测
    clean.ts glossary.ts   # 清洗（噪声/去重/断行合并）与术语词表（存疑只标记不改写）
    config/                # 内容类型配置：generic-lecture / book-commentary / shennong-bencao
    segment.ts             # 章节（粗粒度）+ 主题段落切分（evID 边界，程序算时间）
    summarize.ts card.ts   # 抽取式摘要 + 卡片组装；llm.ts/prompts.ts/mock-llm.ts 为可选 LLM 适配器
    validate.ts            # 卡片校验（字段/时间/依据/覆盖/否定保留/摘录冒充）→ 待复核队列
    store.ts search.ts     # PG vk_* 表写入 + 混合检索（向量∪关键词，按 segment 归并）
    cache.ts runner.ts     # 内容哈希缓存 + 阶段编排（断点续跑/重试/限流/小样本）
  auth.ts                  # 服务端 cookie 会话（getValidSession：ok/unauthenticated/invalid/transient_error）
  yudao.ts                 # Java API 客户端（token/tenant-id/自定义 headers）
data/corpus/
  entries.jsonl            # 倪海厦《人纪》语料 19,294 条（nihai-renji-corpus，CC BY-NC-SA 4.0）
data/vk/
  glossaries/              # 领域术语词表（build-glossary.ts 从语料 h2 数据驱动生成）
  samples/                 # 测试样本：合成非中医字幕 SRT / 20 问评测问题集 / 样例卡片 Markdown
  authors/                 # agent 撰写工作单与卡片 JSON（小批量高质量轨）
scripts/
  regression/              # 排盘回归测试（9 个，`pnpm test` 必须全绿才能合并）
  embed-server.mjs         # embedding 微服务（bge-small-zh-v1.5，端口 3001；挂了检索自动降级关键词）
  kb/                      # import-corpus.mjs（语料导入，可重复执行）+ corpus-tables.sql（pgvector 表结构）
  vk/                      # 视频知识流水线 CLI：run / query / eval-questions / author-cards /
                           #   dump-cards / build-glossary / schema.sql / pipeline.test.ts / e2e-synthetic.test.ts
sql/
  postgresql/ziwei.sql     # 权益模块表结构（PG，幂等脚本）
  mysql/ziwei.sql          # 同结构 MySQL 版
```

## 中医知识库架构（2026-10-13 上线）

```
浏览器 ──▶ Next.js BFF /api/zhongyi/*
             │  ├─ 语义检索：embed-server(3001) 向量化 query → PG pgvector 余弦 Top60
             │  └─ 降级：embed-server 不可用 → 关键词多词 OR（search_text ILIKE）
             ▼
        PostgreSQL（Neon，corpus_book / corpus_entry(embedding vector(512) + HNSW)）
```

- 语料导入：`DATABASE_URL=… node scripts/kb/import-corpus.mjs`（先启动 embed-server；约 11 分钟）
- 版权：语料 CC BY-NC-SA 4.0（仅非商业），课程内容版权归倪海厦先生及其权利继承人；页面保留署名声明
- 回放：每条判语拼 `https://www.bilibili.com/video/{bvid}?t={秒}` 新标签页打开

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
- `docs/video-kb-pipeline.md`：通用视频知识流水线（设计/用法/schema/提示词/实测）
- 根目录 `PLAN.md`（本地）：项目阶段计划与踩坑记录
