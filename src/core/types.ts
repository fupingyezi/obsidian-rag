/**
 * core 的共享类型 + 三个可替换接口(Embedder / Store / LLM)。
 *
 * 这三个接口是整个项目最重要的一次解耦。
 * 换供应商 = 改 config.ts 里的一行构造参数,而不是改一遍业务逻辑。
 *
 * 纪律:本文件不允许 import 任何传输层 / 具体实现 / Node API,
 * core/ 目录整体只面向这些接口写代码,才能脱离网络和数据库单独做单元测试。
 */

// ---------------------------------------------------------------- 数据模型

/** 一个切块:chunk.ts 产出 → store 持久化 → retrieve 消费。 */
export interface Chunk {
  /** vault 内相对路径,回答时给出处用。例:"知识库/Redis 笔记.md" */
  file: string;
  /**
   * 标题路径,例:"Redis > 持久化 > AOF"。
   * 【最关键字段】必须拼进 embedding 输入文本,不能只进 metadata ——
   * 否则「AOF 是什么」这类短问题命中不了一堆正文里没写这个词的片段。
   */
  headingPath: string;
  /** 正文原文(不含 headingPath),用于展示与拼 prompt */
  raw: string;
  /** 文件内绝对行号(1 起),支持跳回原文 */
  lineFrom: number;
  lineTo: number;
  /** 标签(frontmatter tags + 正文 #tag 的并集),检索时当过滤器 */
  tags: string[];
  /** [[双链]] 指向的笔记名列表,第一版只记录、暂不参与检索 */
  links: string[];
}

/** 检索命中的片段(带 id 与分数),retrieve.ts 的中间产物 */
export interface ScoredChunk extends Chunk {
  /** chunks 表主键,也是 vec 表与 FTS 表的 rowid —— RRF 融合靠它 */
  id: number;
  /** 分数越大越相关。RRF 阶段该字段只是占位,rerank 后才有真实含义 */
  score: number;
}

/** 回答附带的出处,ask() 返回给调用方 */
export interface Source {
  file: string;
  headingPath: string;
  text: string;
  lineFrom: number;
  lineTo: number;
  score: number;
}

/** 文件级增量索引元数据(增量判断就靠这三个字段) */
export interface FileMeta {
  /** vault 内相对路径 */
  path: string;
  /** stat().mtimeMs,毫秒时间戳 */
  mtimeMs: number;
  /** 字节数 */
  size: number;
  /** 内容 sha256,判断「mtime 变了但内容没变」的最终依据 */
  hash: string;
}

// ---------------------------------------------------------------- 三个接口

/** 向量化槽位:文本数组 → 向量数组。实现见 adapters/embed.ts(智谱) */
export interface Embedder {
  /** 向量维度。建 vec0 表时需要固定维度,必须在建表前拿到 */
  dim: number;
  /**
   * 顺序保证:第 i 条输入对应第 i 条输出。
   * 批大小(≤64 条)、单条长度限制(保守 3072 token)是适配器内部的事,
   * 调用方只传任意长度的数组。
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** 重排槽位:query + 候选文档 → 相关性分数。实现见 adapters/rerank.ts */
export interface Reranker {
  /**
   * 返回与 docs 等长的分数数组,分数越大越相关。
   * 调用方( retrieve.ts )自行按分数排序取前 topK。
   */
  rerank(query: string, docs: string[]): Promise<number[]>;
}

/**
 * 存储槽位:片段与向量的增删查。实现见 adapters/store.ts(sqlite-vec)。
 * 换 LanceDB 时,只新写一个实现类替换构造参数,core 不动。
 */
export interface Store {
  /** 文件重新切块后的原子替换:删旧块 → 插新块与向量 → 更新文件元数据 */
  upsertFile(meta: FileMeta, chunks: Chunk[], vectors: Float32Array[]): void;
  /** 只更新文件元数据(内容 hash 没变但 mtime/size 变了的情况) */
  touchFile(meta: FileMeta): void;
  /** 文件从磁盘消失时调用,删除其所有片段 */
  deleteFile(path: string): void;
  /** 查文件元数据,mtime+hash 一致时跳过重切 */
  getFileMeta(path: string): FileMeta | undefined;
  /** 库里全部文件路径,用于发现「磁盘上已删除的文件」 */
  listFiles(): string[];
  /** 向量检索:返回 topK 个候选。filterTags 要求命中的块包含全部标签 */
  vectorSearch(qv: Float32Array, topK: number, filterTags?: string[]): Promise<ScoredChunk[]>;
  /** 关键词检索(FTS5):q 是原始查询串,中文分词在适配器内部做 */
  ftsSearch(q: string, topK: number, filterTags?: string[]): Promise<ScoredChunk[]>;
  /** 片段总数,CLI stats 用 */
  count(): number;
  close(): void;
}

/** 生成槽位:prompt → 文本。实现见 adapters/llm.ts(智谱/DeepSeek) */
export interface LLM {
  /** system 给角色设定与引用纪律,user 给片段 + 问题 */
  chat(system: string, user: string): Promise<string>;
}

// ---------------------------------------------------------------- 返回值

/** indexVault 的统计结果 */
export interface IndexResult {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

/** ask 的结果 */
export interface AskResult {
  answer: string;
  sources: Source[];
}
