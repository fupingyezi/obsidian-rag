/**
 * VecDb:向量库的语句与操作层。
 *
 * 文件分工:
 *   schema.ts —— 四张表的 DDL
 *   db.ts     —— 数据库实例(目录/连接/pragma/扩展/执行 DDL)
 *   本文件    —— prepared statements 与行读写、检索,组装 VecDb 对外的 API
 *
 * 中文关键词路:FTS5 默认分词器切不了中文(整句当成一个 token,关键词路等于
 * 没有),这里用 segmentit 预分词:入库与查询都先切成空格分隔的词串,
 * 再交给 tokenize='unicode61' 按空白切,每个中文词就是一个独立 token。
 *
 * 三个已验证的坑:
 *   1. vec0 KNN 必须用 where embedding match ? and k = ? 取前 k 近邻,
 *      参数化 limit 在预编译时检测不到,直接报错
 *   2. vec0 的 rowid 严格校验必须按 INTEGER 绑定,JS number 会被
 *      better-sqlite3 绑成 REAL 而报错 —— 涉及 vec 表 rowid 一律 BigInt
 *   3. FTS5 查询语法的操作符必须大写,小写 or 会被当成普通 token 参与匹配
 *      (这与 SQL 关键字大小写不敏感是两回事)
 */
import * as segmentit from "segmentit";
import type { SegWord } from "segmentit";

import type { FileMeta, ScoredChunk } from "#src/core/types";
import { openDb } from "#src/lib/vec-db/db";

// ── segmentit 懒加载:词典初始化约 1~2 秒,只在第一次用到时初始化 ────────
// ⚠️ 运行时两个入口的导出形态不同:CJS 入口(原生 node 走 main 字段,
// module.exports 间接导出)只有 default;ESM 入口(tsx/打包器走 module 字段)
// 只有命名导出。default ?? 命名空间 兼容两者,再统一取成员:
const { Segment, useDefault } = segmentit.default ?? segmentit;

let segmenter: {
  doSegment: (text: string, options?: { stripPunctuation?: boolean }) => SegWord[];
} | null = null;

function getSegmenter(): NonNullable<typeof segmenter> {
  segmenter ??= useDefault(new Segment());
  return segmenter;
}

function segmentText(text: string): string {
  return getSegmenter()
    .doSegment(text, { stripPunctuation: true })
    .map((w) => w.w)
    .join(" "); // 空格分隔的词串,入库与查询共用,保证 token 形态一致
}

/** 一个片段入库需要的全部字段,由上层(store)组装好传进来 */
export interface VecChunkInput {
  file: string;
  headingPath: string;
  raw: string;
  /** headingPath + raw,实际被向量化的文本,必须与传入的向量内容一致 */
  embedText: string;
  lineFrom: number;
  lineTo: number;
  tags: string[];
  links: string[];
}

/** 向量库对外的全部能力,方法名与 SQL 一一对应,不掺业务语义 */
export interface VecDb {
  /** 把一段 DB 操作包进事务,store 用它把多次操作编成一次原子状态迁移 */
  transaction(fn: () => void): void;
  upsertFileMeta(meta: FileMeta): void;
  getFileMeta(path: string): FileMeta | undefined;
  deleteFileMeta(path: string): void;
  listFiles(): string[];
  /** 一个片段的三表插入(chunks + vec + fts),返回 chunks.id */
  insertChunk(chunk: VecChunkInput, vector: Float32Array): number;
  /** 删光一个文件在 chunks/vec/fts 三表里的全部片段行 */
  deleteChunksByFile(path: string): void;
  countChunks(): number;
  /** 向量路召回:取离 qv 最近的 limit 个片段,score = 1/(distance+ε),越大越相关 */
  knnSearch(qv: Float32Array, limit: number): ScoredChunk[];
  /** 关键词路召回:查询串分词后各词 OR 匹配,score = -bm25,越大越相关 */
  ftsSearch(q: string, limit: number): ScoredChunk[];
  close(): void;
}

/** select 出的行(chunks 表列 + 两路检索各自附带的分数列,二选一出现) */
interface ChunkRow {
  id: number;
  file_path: string;
  heading_path: string;
  raw: string;
  line_from: number;
  line_to: number;
  tags: string;
  links: string;
  distance?: number; // 向量路的 L2 距离
  rank?: number; // 关键词路的 bm25 分数
}

/** files 表的行 */
interface FileMetaRow {
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
}

/** 创建 VecDb:打开数据库实例(见 db.ts)并准备全部语句 */
export function createVecDb(dbPath: string, dim: number): VecDb {
  const db = openDb(dbPath, dim);

  // ── prepared statements ──────────────────────────────────────────────────
  const selectIdsByFile = db.prepare<unknown[], { id: number }>(
    "select id from chunks where file_path = ?",
  );
  const deleteVecRow = db.prepare("delete from vec_chunks where rowid = ?");
  const deleteFtsRow = db.prepare("delete from chunks_fts where rowid = ?");
  const deleteChunkRow = db.prepare("delete from chunks where id = ?");
  const insertChunkStmt = db.prepare(`
    insert into chunks (file_path, heading_path, raw, embed_text, line_from, line_to, tags, links)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare("insert into vec_chunks (rowid, embedding) values (?, ?)");
  const insertFts = db.prepare(
    "insert into chunks_fts (rowid, fts_text, heading_path) values (?, ?, ?)",
  );
  const upsertFileMetaStmt = db.prepare(`
    insert into files (path, mtime_ms, size, hash) values (?, ?, ?, ?)
    on conflict(path) do update set
      mtime_ms = excluded.mtime_ms, size = excluded.size, hash = excluded.hash
  `);
  const selectFileMeta = db.prepare<unknown[], FileMetaRow>(
    "select path, mtime_ms, size, hash from files where path = ?",
  );
  const deleteFileMetaStmt = db.prepare("delete from files where path = ?");
  const selectAllPaths = db.prepare<unknown[], { path: string }>("select path from files");
  const selectCount = db.prepare<unknown[], { n: number }>("select count(*) as n from chunks");
  const selectKnn = db.prepare<unknown[], ChunkRow>(`
    select c.id, c.file_path, c.heading_path, c.raw, c.line_from, c.line_to,
           c.tags, c.links, v.distance
    from vec_chunks v
    join chunks c on c.id = v.rowid
    where v.embedding match ? and k = ?
  `);
  const selectFts = db.prepare<unknown[], ChunkRow>(`
    select c.id, c.file_path, c.heading_path, c.raw, c.line_from, c.line_to,
           c.tags, c.links, bm25(chunks_fts) as rank
    from chunks_fts
    join chunks c on c.id = chunks_fts.rowid
    where chunks_fts match ?
    order by rank
    limit ?
  `);

  // 复用同一个事务包装器;store 在事务里再调其他方法时自动退化为 savepoint
  const withTx = db.transaction((fn: () => void): void => {
    fn();
  });

  /** 行 → ScoredChunk。score 由调用方给:向量路 1/(distance+ε),关键词路 -rank */
  function toScoredChunk(r: ChunkRow, score: number): ScoredChunk {
    return {
      id: r.id,
      file: r.file_path,
      headingPath: r.heading_path,
      raw: r.raw,
      lineFrom: r.line_from,
      lineTo: r.line_to,
      tags: JSON.parse(r.tags) as string[],
      links: JSON.parse(r.links) as string[],
      score,
    };
  }

  function insertChunk(chunk: VecChunkInput, vector: Float32Array): number {
    const info = insertChunkStmt.run(
      chunk.file,
      chunk.headingPath,
      chunk.raw,
      chunk.embedText,
      chunk.lineFrom,
      chunk.lineTo,
      JSON.stringify(chunk.tags),
      JSON.stringify(chunk.links),
    );
    const id = Number(info.lastInsertRowid);
    insertVec.run(BigInt(id), vector); // rowid 按 INTEGER 绑定;Float32Array 绑成 blob,维度必须与建表一致
    insertFts.run(id, segmentText(chunk.raw), segmentText(chunk.headingPath));
    return id;
  }

  function deleteChunksByFile(path: string): void {
    for (const { id } of selectIdsByFile.all(path)) {
      deleteVecRow.run(BigInt(id));
      deleteFtsRow.run(id);
      deleteChunkRow.run(id);
    }
  }

  function getFileMeta(path: string): FileMeta | undefined {
    const row = selectFileMeta.get(path);
    return row
      ? { path: row.path, mtimeMs: row.mtime_ms, size: row.size, hash: row.hash }
      : undefined;
  }

  function knnSearch(qv: Float32Array, limit: number): ScoredChunk[] {
    // 距离越小越相似 → 取倒数翻成正相关,ε 防止距离为 0 时除零
    const rows = selectKnn.all(qv, limit);
    return rows.map((r) => toScoredChunk(r, 1 / (r.distance! + 1e-6)));
  }

  function ftsSearch(q: string, limit: number): ScoredChunk[] {
    // 查询串同样分词;每个 token 包成 FTS5 短语,之间用 OR 连接 ——
    // 关键词路要的是召回率,命中任意一个词就进候选,由 RRF 去排
    const tokens = segmentText(q).split(" ").filter(Boolean);
    if (tokens.length === 0) return []; // 纯标点查询,分词结果为空
    // FTS5 查询语法的操作符必须大写,小写 or 会被当成普通 token 参与匹配(与 SQL 关键字不同)
    const matchQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const rows = selectFts.all(matchQuery, limit);
    return rows.map((r) => toScoredChunk(r, -r.rank!)); // bm25 越小越相关,取负号翻成正相关
  }

  return {
    transaction: (fn) => withTx(fn),
    upsertFileMeta: (meta) => upsertFileMetaStmt.run(meta.path, meta.mtimeMs, meta.size, meta.hash),
    getFileMeta,
    deleteFileMeta: (path) => deleteFileMetaStmt.run(path),
    listFiles: () => selectAllPaths.all().map((r) => r.path),
    insertChunk,
    deleteChunksByFile,
    countChunks: () => selectCount.get()?.n ?? 0,
    knnSearch,
    ftsSearch,
    close: () => db.close(),
  };
}
