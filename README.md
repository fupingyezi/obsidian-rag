# obsidian-rag

本地 Obsidian 笔记库的 RAG 问答工具:把 markdown 笔记按标题切块、向量化存进
SQLite(sqlite-vec + FTS5),提问时混合检索 + 重排,LLM 生成**带出处**的回答
—— 笔记里没有的内容会如实说没有,不编造。

全链路只依赖智谱 / DeepSeek 的 API,个人库量级下费用可以忽略不计。

## 快速开始

要求 Node ≥ 20.12(`process.loadEnvFile`)。

```bash
cp .env.example .env   # 填 ZHIPU_API_KEY 和 VAULT_ROOT(库根目录绝对路径)
npm install
npm run index          # 建库:增量,只处理新增/修改过的文件
npm run ask -- "Redis 持久化有哪几种方式?"
npm run chat           # 交互式连续提问
```

## 命令

| 命令 | 作用 |
|------|------|
| `npm run index` | 全量/增量建库,按 mtime + sha256 跳过没变的文件;`-w` 建完持续监听 |
| `npm run ask -- "问题"` | 一次性提问,打印答案与出处(文件:行号) |
| `npm run chat` | 交互式问答,一个进程连续问,`exit` / Ctrl-D 退出 |
| `npm run watch` | 只跑监听:保存笔记即更新索引 |
| `npm run stats` | 索引统计(文件数 / 片段数) |
| `npm run mcp` | 启动 MCP server(stdio),供 Claude Code / Cursor 接入 |

ask / chat 通用选项:`-k <n>` 交给生成模型的片段数(默认 5),
`-t 数据库,面试` 按标签过滤(要求片段包含全部标签)。

## 配置(.env)

| 变量 | 说明 | 默认 |
|------|------|------|
| `ZHIPU_API_KEY` | 必填,向量化槽位固定智谱 | |
| `VAULT_ROOT` | 必填,Obsidian 库根目录绝对路径 | |
| `EMBED_MODEL` / `EMBED_DIM` | 向量模型 / 维度(256–2048) | `embedding-3` / `1024` |
| `RERANK_PROVIDER` | `zhipu` 开重排,`none` 关(直接用融合排名) | `none` |
| `RERANK_MODEL` | 重排模型名 | `rerank` |
| `LLM_PROVIDER` / `LLM_MODEL` | 生成模型,`zhipu` 或 `deepseek` | `zhipu` / `GLM-4.7-Flash` |
| `DEEPSEEK_API_KEY` | 仅 `LLM_PROVIDER=deepseek` 时必填 | |
| `DB_PATH` | 索引库位置 | `.data/rag.db` |

## 工作原理

**建库**:扫描 `.md`(跳过隐藏文件)→ mtime + sha256 判断增量 → 按标题层级切块。
每块携带 `headingPath`(如 `Redis > 持久化 > AOF`),它会被拼进向量化文本
—— 否则「AOF 是什么」这类短问题命中不了正文里没出现这个词的片段。

**提问**:两路召回并行 —— 向量 KNN(语义)+ FTS5 关键词(精确术语,中文用
segmentit 预分词)→ 各取 50 条,RRF(k=60)融合排名取前 20 → rerank 精排 →
前 5 条交给 LLM。系统提示词要求:只根据给定片段回答、逐条给出处、片段不够就
明说「笔记中没有相关记录」。

```
src/
├── config.ts        组装根:环境变量 → 构造各槽位 adapter → 注入 core
├── core/            业务核心,零环境依赖(不许 HTTP / argv / console)
│   ├── types.ts       数据模型 + Embedder / Reranker / Store / LLM 四接口
│   ├── chunk.ts       按标题切块:headingPath / tags / links / 行号
│   ├── retrieve.ts    混合召回 → RRF 融合 → rerank → topK
│   └── index.ts       Core 门面:indexVault(建库+监听)/ ask(检索+生成)
├── adapters/        供应商适配,唯一允许 HTTP 的层
│   ├── embed.ts       智谱 embedding-3
│   ├── rerank.ts      智谱 rerank(裸 fetch)
│   ├── llm.ts         智谱 / DeepSeek(openai SDK)
│   └── store.ts       Store 适配:文件级状态迁移(单事务)+ 检索编排
├── lib/vec-db/      SQLite 细节:DDL(files/chunks/vec_chunks/chunks_fts)、KNN、FTS5
├── shell/           壳:cli.ts(命令行)/ mcp.ts(MCP server,stdio)
└── types/           第三方类型补丁(segmentit)
```

换供应商 = 改 `.env` 一个变量;core 对供应商一无所知。

## 接入 MCP(Claude Code / Cursor)

stdio MCP server,工具面只有两个,刻意保持窄:

| 工具 | 作用 |
|------|------|
| `search_notes` | 混合检索笔记库,返回片段原文与出处(路径:行号 + 标题路径) |
| `reindex_vault` | 增量同步索引,返回统计 |

**没有「生成答案」的工具** —— 宿主模型(Claude 等)自己读片段、自己作答,
检索与生成分离,宿主才有主动权。自带生成的完整问答是 CLI 的 ask / chat。

Claude Code:

```bash
claude mcp add obsidian-rag -- npx tsx /path/to/obsidian-rag/src/shell/mcp.ts
```

Cursor(`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "obsidian-rag": {
      "command": "npx",
      "args": ["tsx", "/path/to/obsidian-rag/src/shell/mcp.ts"]
    }
  }
}
```

`.env` 与数据库路径都以项目根为基准,和宿主从哪个目录拉起进程无关。
改了 `mcp.ts` 之后跑 `npx tsx eval/mcp-smoke.ts` 冒烟(它会故意从 `/tmp`
拉起 server,顺带守住这条不变量)。

## 准确度调优

改任何参数(维度 / 分块粒度 / rerank 开关 / topK)之前,先把
[eval/questions.md](eval/questions.md) 里的 20 道评测题填上 —— 出题技巧和
对比表都在文件里。没有评测题,调参全凭体感。

## 路线图

- [ ] 自动评测:采样已索引片段生成问题,测 top-3 命中率
- [ ] 分块策略:长小节截断处的续篇片段召回
