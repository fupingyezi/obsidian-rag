# CLAUDE.md

本地 Obsidian RAG:TypeScript ESM。笔记按标题切块 → 智谱向量化 → SQLite
(sqlite-vec + FTS5)双表存储 → 混合召回 + RRF + rerank → LLM 带出处回答。
三个槽位(Embedder / Reranker / LLM)+ Store,依赖注入,core 对供应商一无所知。

## 环境与测试纪律(优先级最高)

- `.env` 里有真实 key 和真实库路径(`/Users/yoshiko/note/note`):
  永远不要打印它的值、不要整文件覆盖;改配置只动目标行
- `.env` 与相对 `DB_PATH` 以项目根为基准(config.ts 的 `PROJECT_ROOT`),
  不随进程 cwd 漂移 —— MCP 宿主用任意 cwd 拉进程;`eval/mcp-smoke.ts`
  从 /tmp 拉起 server 就是在守这条不变量
- 冒烟测试不许碰真实库:用环境变量覆盖 `VAULT_ROOT` / `DB_PATH` 指向临时目录。
  `process.loadEnvFile()` 不会覆盖已存在的环境变量,所以 export 覆盖一定生效
- openai SDK 遇 429 自动指数退避重试,表现为「卡住」—— 不是死锁,少打几次 API
- macOS 系统 `sqlite3` 没有 FTS5 模块;查库一律走项目里的 better-sqlite3

## 分层规则(改代码前必读)

- `core/` 禁止 HTTP / MCP / argv / console,只面向四个接口写;回调(onUpdate /
  onError)把日志职责交还给 shell
- `adapters/` 是唯一允许 HTTP 的层;`lib/vec-db/` 收拢全部 SQL / DDL / 分词
- `shell/` 才许碰 argv 和 console;`config.ts` 是组装根(唯一同时 import
  core 和 adapters 的地方)
- 依赖方向:shell → config → { core, adapters } → lib;core 不知道 adapters 存在
- 根 tsconfig 只编译 src(产物干净);eval/ 有自己的 noEmit tsconfig 接住
  IDE 与类型检查,`npm run typecheck` 已串上两个工程 —— 别把 eval 加回根 include

## 不变量

- `headingPath` 必须拼进向量化文本(`toEmbedText`)—— 只进 metadata 的话
  术语题(「AOF 是什么」)命中不了正文里没写这个词的片段
- 建表维度取 `embedder.dim`(单一事实来源),不要从环境变量二次读
- `chunks.id` = `vec_chunks.rowid` = `chunks_fts` rowid 三表对齐,RRF 融合靠它,
  插入必须显式指定 rowid
- `upsertFile` 是单事务(删旧块 → 插新块 → 更新元数据),不许拆开
- `exactOptionalPropertyTypes` 开着:可选属性不要传 `undefined`,用条件展开

## 外部接口的坑(全部实测踩过)

- vec0 KNN:`where v.embedding match ? and k = ?`;rowid 绑定要 BigInt
- FTS5 查询里的 `OR` 必须大写(它是 FTS5 操作符,不受 SQL 小写约定约束)
- segmentit:`import * as segmentit` + `(default ?? namespace)` 兜底
- 智谱 rerank 模型名是 `rerank`(`GLM-rerank` 不存在,返回 1211)。
  该接口分数分布极度压缩 —— 不相关文档也有 0.99+,绝对分数不能做拒答阈值,
  只有相对排序有效
- chat 的 readline:不要用 `question()`(同一 data 块多行会丢),
  自己维护行队列 + waiter,见 `shell/cli.ts`
- MCP stdio 下 stdout 被协议占用,`mcp.ts` 里日志只能走 console.error
- MCP SDK 的 StreamableHTTPServerTransport:回调是 getter/setter 声明
  (写类型带 undefined),`exactOptionalPropertyTypes` 下接不进 Transport
  接口,要 `as unknown as Transport` 桥接;无会话模式 = 省略
  sessionIdGenerator(显式传 undefined 会被同一选项拦)

## 代码风格

- 双引号、2 空格缩进、中文注释
- import 用 `#src/…` 别名、免后缀(如 `#src/core/types`):运行时靠
  package.json 的 `imports` 字段解析,锚定在导入文件、cwd 无关 —— MCP 宿主
  从任意目录拉进程都成立。别用 `@/`:tsx 的 tsconfig paths 发现锚定 cwd,
  换目录启动就 `ERR_MODULE_NOT_FOUND`;也别用 `#/` 开头,那是 Node 保留的
  非法形式。tsconfig 里的 `paths` 只为 tsc 提供同一映射
- bundler 解析契约:`npm run build` 的 dist 不能再用 node 直跑,全项目经 tsx 运行
- SQL 关键字小写(`select` / `create table`),FTS5 模块名与语法保留大写
  (`fts5` 虚表名小写、`OR` 大写)
- 注释只描述设计本身,不引用外部文档章节号
- 新模块默认给注释式实现指引(骨架),用户点名要完整实现时才写全
- MCP 已实现(`shell/mcp.ts`,SDK 1.31 的 `registerTool`)。一套工具三种
  传输:stdio(默认)、Streamable HTTP(`--http`,/mcp,无会话)、旧版
  SSE(/sse,连接态,给老客户端);HTTP 默认只绑 127.0.0.1。
  工具面只有 search_notes / reindex_vault,刻意不做「生成」工具 ——
  宿主自己有模型,给它片段即可。改完跑两个冒烟:
  `npx tsx eval/mcp-smoke.ts`(stdio)、`npx tsx eval/mcp-http-smoke.ts`(HTTP)
