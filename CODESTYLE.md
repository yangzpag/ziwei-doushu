# 代码风格与约定（CODESTYLE）

> 本项目的约定来自实战踩坑。**新增代码必须遵守；PR 提交前过一遍文末自审清单。**

## TypeScript / Next.js

1. **BFF 会话语义（强约定）**
   - 未登录 → `401`（前端据此引导登录）
   - 上游抖动/超时 → `503`（前端显示重试，**不得**误导为游客）
   - yudao 业务错误 → `400` + `{ message, code }`；`YudaoError.code === 401` 时保持 HTTP 401
   - 实现统一走 `app/api/ziwei/_session.ts` 的 `requireSessionToken` / `yudaoErrorToResponse`
2. **cookie 写入只发生在 Route Handler**——Server Component 渲染期间写 cookie 会抛错；页面需要会话一律走 `/api/auth/me` 或对应 BFF 路由（客户端组件）
3. **SSE 流式读取**：`reader.read()` 的 chunk 可能在事件中间截断——必须保留不完整的行到下一轮再解析（参考 `components/v2/AiSidePanel.tsx` 的 buffer 模式）
4. **前端错误态**：列表/详情加载失败必须显示错误 + 重试入口，不得停留在"加载中…"
5. **计费操作**：bizNo 由**服务端生成**（不信任客户端）；`thinking: { type: 'disabled' }`（推理模型默认思考会耗尽 max_tokens 导致无正文）
6. 状态机类型收紧（`'loading' | 'ready' | 'error'`），新增状态记得同步更新类型声明

## Java（yudao-module-ziwei）

1. **SQL 方言分支**：懒创建等无法跨方言的语句，按 `ZiweiDbDialect.isPostgreSQL()` 分支（PG: ON CONFLICT / MySQL: INSERT IGNORE）；方言检测失败 **fail fast 终止启动**
2. **禁止依赖 DuplicateKeyException 兜底**——PG 语句失败会中止整个事务；用 ON CONFLICT / INSERT IGNORE / 原子 UPDATE
3. **配额/余额类变更必须原子**：`UPDATE ... WHERE used < limit` / `WHERE balance >= points`，禁止 count-then-insert
4. **bizNo 幂等**：唯一索引 `(member_user_id, biz_no)`；重放校验须比对操作类型+数量，不一致抛 `ZIWEI_POINTS_BIZ_CONFLICT`
5. **退款只认本人真实 CONSUME 流水**；退款流水 bizNo = 原 bizNo + `:refund`（列宽 varchar(80) 已预留）
6. **app-api 默认要求登录**（全局 `anyRequest().authenticated()`）——免登录必须显式 `@PermitAll`；本版本**没有** `@PreAuthenticated` 注解，admin 权限点用 `@ss.hasPermission('权限串')`
7. **金额/次数变动必须写流水**（ziwei_points_log），余额可由流水追溯

## 数据库

- 表结构唯一来源：`sql/postgresql/ziwei.sql`（PG）与 `sql/mysql/ziwei.sql`（MySQL），**幂等脚本**（IF NOT EXISTS），两方言同步更新
- 每表必须有 PRIMARY KEY；列宽要预留（如 biz_no varchar(80) 容纳 `:refund` 后缀）
- 跨方言不可用的语法（PG 部分索引、advisory lock）在 MySQL 脚本头部注明替代方案

## 提交前自审清单（每次 PR 必做两遍）

1. 逐文件重读 diff，站在 reviewer 视角找逻辑/边界/并发问题
2. 跨方言语义核对（PG vs MySQL 事务行为、类型映射、语法差异）
3. 幂等、竞态、错误处理路径闭环（重试/超时/部分失败）
4. `pnpm test` 8 个回归测试全绿；`pnpm build` 类型检查通过
5. 引用的类/方法/列真实存在（改过 SQL 后核对 DO 字段）
6. **同步 `REPOLAYOUT.md`**（新增目录/接口族/表时）
