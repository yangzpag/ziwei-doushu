# 通用视频知识流水线（vk）

> 状态：**v1 已交付**（2026-10-14）。关联：REPOLAYOUT.md / CODESTYLE.md / 语料 nihai-renji-corpus（CC BY-NC-SA 4.0）
>
> 定位：把「视频字幕/摘录」加工成「可读知识段落 + 带视频出处的知识卡片」，
> 替换原先「返回几句截断字幕」的检索形态。用户先读段落摘要，判断是否看视频，再点时间点跳转 B 站。

---

## 1. 设计原则（来自需求方，逐条对应实现）

| 要求 | 实现 |
|---|---|
| 先看到完整有信息量的段落摘要 | 每段一张卡片：标题 + 摘要 + 整理文本 + 要点（每条挂字幕 ID） |
| 点击时间点跳转 | B 站链接由**程序**依据 BV 号/分P/字幕 ID 边界计算（`lib/vk/timeline.ts`），任何阶段不编造时间戳 |
| 不要只返回截断字幕 | 检索返回**完整卡片**（标题/摘要/正文/关键词/出处），不是字幕碎片 |
| 通用流程 + 可配置内容类型 | 通用模块（导入/时间轴/清洗/切分/摘要/校验/索引）零领域知识；领域差异全在 `lib/vk/config/` |
| 不写死药材/中医结构 | 第一版内置 `generic-lecture` / `book-commentary` 两个基础配置 + `shennong-bencao` 领域配置；新增类型 = 加一个配置文件 |
| 摘要不得编造 | 抽取式：要点必须能在原文找到（LCS≥60%）；agent 撰写：二元组重叠 + 人工抽查告警 |
| 区分 full_transcript 与 excerpt | `VideoMeta.mode` 全链路传递；摘录卡片强制 `completeness=partial`，校验器有 `excerpt-masquerade` 专检 |
| 摘录缺口不得拼接 | 超过 `maxMergeGapMs` 强制断开，缺口记入 `gapBeforeMs/internalGapsMs` |
| 结束时间不冒充 | 来源只有起始时间时 `tEndMs=null`，卡片展示「摘录无结束时间」 |
| 讲者观点 ≠ 已证实结论 | 每张卡片 `typeFields.viewpoint='speaker'` |
| 信息不完整要明说 | `needs_context` 状态 + 待复核队列，不补写缺失讲解 |
| 多模态预留 | 字幕/OCR/画面描述统一为带时间戳 Evidence（`source` 字段），第一版只用 subtitle/excerpt |

## 2. 数据现实与降级策略

仓库现有语料 = **19,294 条摘录**（倪海厦《人纪》，短引文 + 起始时间，无完整逐字稿、无 SRT/VTT）：

- 走 `excerpt` 模式：按语料 h2（药材/条文）分章节，章节内按摘录间隔（excerpt 专属阈值 45s/120s）切主题段；
- 卡片明确标记 `completeness=partial`，**不宣称完整段落整理**；缺上下文处摘要里如实说明（如「上下文缺失，具体所指待查」）；
- 拿到完整字幕后，SRT/VTT/字幕 JSON 适配器直接走 `full_transcript` 模式（连续覆盖校验、句界完整性切分自动生效），无需改代码。

## 3. 架构

```
来源文件（SRT/VTT/JSON/摘录JSONL）
   │  adapters/（格式探测 + 统一 Evidence：id/seq/tStart/tEnd/rawText/meta）
   ▼
import ──► clean ──► segment ──► card ──► validate ──► index ──► 查询
            │          │           │          │           │
        噪声/去重    章节+主题段   摘要/要点   字段/时间/    PG + pgvector
        断行合并     碎片合并      keywords   依据/覆盖    混合检索
        词表标记     evID边界                否定保留
   │
   每阶段产物落盘 data/vk/runs/<runId>/，缓存键 = 内容哈希 + 配置版本（lib/vk/cache.ts）
   上游变化 → 哈希变化 → 下游缓存自动失效；支持断点续跑/失败重试/并发限流/小样本
```

**双轨生成**（card 阶段）：

| 模式 | 说明 | 验证方式 |
|---|---|---|
| `extractive` | 确定性抽取式摘要，零外部调用，全量兜底 | LCS 原文支持度 ≥60% |
| `agent` | 会话内 AI 助手读「撰写工作单」后亲自写卡片（小批量高质量） | 二元组重叠 ≥2 + **需人工抽查告警** |
| `llm` | 可选外部 LLM 适配器（`lib/vk/llm.ts`，默认不启用，密钥从环境变量读） | 同 agent |
| `mock` | 链路测试用假实现，输出带 `[MOCK]` 标识 | 不作真实结果 |

agent 撰写流程：`author-cards.ts --dump` 导出工作单（段落+证据字幕）→ AI 撰写 JSON → `--load` 合入（程序补整理文本/时间/链接、重跑校验、**同步写回卡片缓存**防止被重跑覆盖）。

## 4. 内容类型配置

```ts
// lib/vk/config/configs.ts
interface ContentTypeConfig {
  chapter:   { sourceFields; textPatterns; fallbackTitle }   // 粗粒度章节线索
  clean:     { noisePatterns; minCueChars; mergeGapMs; dedupeWindowMs }
  segment:   { refDurationMs; gapMs; maxMergeGapMs; excerpt{…}; transitionPatterns;
               sentenceEnders; minEvidence; minChars; maxExtendMs }
  summary:   { focus; targetChars; priorityPatterns; fillerPatterns }
  structuredFields: [{ name, kind, patterns?/fromGlossary? }]  // 类型专属可选字段
  validation:{ requireContinuity; mustKeepPatterns; excerptMustBePartial }
  glossaryFile?: string                                       // 术语词表（数据驱动生成）
}
```

- 内置：`generic-lecture`（兜底）/ `book-commentary`（原书讲解）/ `shennong-bencao`（领域配置）
- 章节级可切换类型：章节文本/词表命中更具体配置才切换，打平或不确定 → 回退视频级/通用讲解，**不强行分类**
- 切分目标 = 完整理解单元；时长/停顿/口头切换语只是候选边界；段尾须落在句末标志上，否则向后找（`maxExtendMs`）；低于最小段长的碎片段按「是否以切换语开头」决定向前/向后合并
- 新增内容类型：复制一个配置文件 + （可选）词表文件，注册进 `BUILTIN_CONFIGS`，通用模块零改动

## 5. 校验与待复核

`lib/vk/validate.ts` 逐卡检查：字段完整性 / 字幕 ID 存在性与视频对应 / 时间合法性 / 连续模式段内序号缺口 / 跨段重复覆盖 / 摘要要点无依据 / 否定条件转折丢失 / 摘录冒充完整 / 证据待复核标记透传。

- 硬错误（时间非法、证据不存在）→ `rejected`；可修复问题 → `needs_review`；仅告警 → `validated`
- 未通过卡片进 `vk_review` 待复核队列，**不作为已验证结果发布**
- agent 卡片一律带 `agent-authored` 告警：转述支持度无法全自动验证，需人工对照原文（样例卡片 Markdown 即为此生成：`dump-cards.ts`）

## 6. 存储与检索

Neon PG 新增 `vk_*` 表（与 `corpus_*` 同库，additive，不动旧表；schema：`scripts/vk/schema.sql`）：

```
vk_video  视频源（bvid/cid/part/mode/contentType/license/source/importVersion）
vk_evidence  证据（raw_text 不可覆盖；clean_text/clean_ops/review_flags/dropped/merged_into）
vk_chapter / vk_segment  章节 / 主题段（ev_ids 边界 + internal_gaps_ms + completeness）
vk_card   知识卡片（1:1 segment；points/keywords/type_fields/quality/gen_mode/prompt_version）
vk_chunk  检索块：head（标题+摘要+关键词）/ body（正文拆块），统一关联 segment_id，embedding vector(512)
vk_review 待复核队列  |  vk_run 运行记录
```

检索（`lib/vk/search.ts`）：向量 Top40 ∪ 关键词字面 Top20 → 按 `segment_id` 归并（head 加分，同段多块不重复）→ 返回完整卡片 + 程序生成的 B 站链接；支持课程筛选；embed-server 不可用降级纯关键词。

## 7. 使用说明

```bash
# 0) 生成领域词表（从语料 h2 数据驱动，不写死药材）
tsx scripts/vk/build-glossary.ts --source data/corpus/entries.jsonl --book 03-bencao \
  --out data/vk/glossaries/shennong-bencao-herbs.txt

# 1) 摘录库小样本（本草经第 12 集）
tsx scripts/vk/run.ts --source data/corpus/entries.jsonl --format excerpt-jsonl \
  --content-type shennong-bencao --only-video 03-bencao-ep12 --run-id bencao-ep12

# 2) 完整字幕（任意课程，换 --content-type 即可复用）
tsx scripts/vk/run.ts --source lecture.srt --format srt --video-id photo-101 \
  --course-id photo --course-name 摄影基础 --bvid BV1xxx --content-type generic-lecture

# 3) 写 PG 索引（DATABASE_URL + 本地 embed-server）
tsx scripts/vk/run.ts … --index

# 4) agent 撰写（小批量）
tsx scripts/vk/author-cards.ts --dump --run <id> --video <vid> --out worksheet.json
#   （AI 读工作单撰写 cards.json）
tsx scripts/vk/author-cards.ts --load --run <id> --video <vid> --cards cards.json

# 5) 查询 / 评测 / 样例导出
tsx scripts/vk/query.ts "半夏止恶心配什么药" --course 03-bencao
tsx scripts/vk/eval-questions.ts --questions data/vk/samples/eval-questions-bencao-ep12.json
tsx scripts/vk/dump-cards.ts --run-id bencao-ep12 --limit 12 --out samples.md

# 6) 测试
tsx scripts/vk/pipeline.test.ts        # 10 组单测（无网络/DB）
tsx scripts/vk/e2e-synthetic.test.ts   # 合成非中医字幕端到端
```

阶段可拆分（`--stages import,clean,segment,card,validate`），断点续跑、`--force` 重跑、`--limit/--only-video` 小样本、`--concurrency/--retries`。环境变量：`DATABASE_URL`、`EMBED_URL`（默认 127.0.0.1:3001）、LLM 可选 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`。费用估算仅在配置单价环境变量时进行，不猜。

## 8. 提示词（LLM 可选适配器）

见 `lib/vk/prompts.ts`。核心约束：只能依据给定字幕；每个要点挂字幕 ID；禁止生成/推测时间戳；信息不足必须标记 `needs_context`；课程内容一律是讲者观点。默认流程不使用 LLM。

## 9. 实测结果（2026-10-14）

- **单测** 10/10：时间轴/适配器/词表/清洗/切分/摘要/校验/缓存/配置
- **合成非中医字幕**（摄影课 SRT，generic-lecture）：9 卡，validated=9，8 complete + 1 needs_context（结尾弱信息段，如实标记）；断点续跑/阶段独立/mock LLM 均通过；核心流程**零代码复用**得证
- **本草经 ep12 真实数据**（151 条摘录）：29 张 agent 撰写卡片，全部 validated，每卡可溯源字幕 + B 站时间点（样例：`data/vk/samples/sample-cards-bencao-ep12.md`）
- **本草经全 14 集**：444 张抽取式卡片 + ep12 的 29 张 agent 卡片入 PG 索引
- **20 问评测**（`data/vk/samples/eval-questions-bencao-ep12.json`，报告见 git 历史/运行产物）：可自动判定 18 题全部命中（前三条含目标段落）；2 道无答案问题（针灸/紫微）按规则不做自动判定、记录前三条供人工复核——**当前检索对无答案问题仍会返回低分结果，这是已知限制**（见下）

## 10. 已知限制与下一步

1. 无答案问题没有置信度阈值，仍返回 top-N（评测中已如实标注为人工复核项）→ 下一步：加分数阈值/「无相关结果」空态
2. 摘录卡片是「多句引文拼装」，读感不如完整逐字稿 → 已用 partial 降级标记；拿到完整字幕后自动升级
3. 词表从语料 h2 生成，含少量非药名章节标题（如「序例」）→ 可在词表文件手工 prune
4. 自动校验只是筛查：agent 卡片转述支持度、要点完整性必须人工抽查（样例 Markdown 就是为这个生成的）
5. OCR/画面描述 Evidence 接口已预留未实现；原著对照字段（book_id/edition_id/passage_id）已预留未实现
6. 尚未接入网站 UI（本期只做流水线 + CLI + PG 索引）
