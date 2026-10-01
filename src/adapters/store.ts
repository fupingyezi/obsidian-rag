/**
 * Store 适配器:只做状态流转,不碰 SQL。
 *
 * 所有「向量数据库及其操作」(连接、DDL、语句、分词、行读写)都在
 * lib/vec-db;这里专注两件事:
 *
 *   1. 文件级状态迁移:upsertFile 用单事务把「删旧块 → 插新块与向量
 *      → 更新元数据」编成一个不可分割的整体,中途失败整体回滚,
 *      库里不会出现「半个文件」的状态。文件被清空时 chunks 为空数组,
 *      旧片段全部删除 —— 旧内容立刻不可检索,这正是想要的行为
 *
 *   2. 检索编排:两路召回各多取 4 倍候选(个人库量级无性能压力),
 *      标签过滤放 JS 侧,过滤后截 topK
 */
import { toEmbedText } from "#src/core/chunk";
import type { ScoredChunk, Store } from "#src/core/types";
import { createVecDb } from "#src/lib/vec-db/index";

/** 创建基于 sqlite-vec 的 Store。dim 必须与 Embedder.dim 一致(vec0 建表时固定维度) */
export function createStore(dbPath: string, dim: number): Store {
  const db = createVecDb(dbPath, dim);

  /** 标签过滤(要求包含全部 filterTags)+ 截断 topK;行已在 vec-db 里解析成 ScoredChunk */
  function finish(
    rows: ScoredChunk[],
    topK: number,
    filterTags: string[] | undefined,
  ): ScoredChunk[] {
    const kept = filterTags
      ? rows.filter((r) => filterTags.every((t) => r.tags.includes(t)))
      : rows;
    return kept.slice(0, topK);
  }

  return {
    upsertFile(meta, chunks, vectors) {
      if (chunks.length !== vectors.length) {
        throw new Error(`chunks 与 vectors 长度不一致:${chunks.length} vs ${vectors.length}`);
      }
      db.transaction(() => {
        db.deleteChunksByFile(meta.path); // 清场旧状态
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          db.insertChunk(
            {
              file: meta.path, // 以 meta.path 为准,保证 files 与 chunks 的主键一致
              headingPath: chunk.headingPath,
              raw: chunk.raw,
              embedText: toEmbedText(chunk),
              lineFrom: chunk.lineFrom,
              lineTo: chunk.lineTo,
              tags: chunk.tags,
              links: chunk.links,
            },
            vectors[i]!,
          );
        }
        db.upsertFileMeta(meta); // 收口新状态
      });
    },

    touchFile(meta) {
      db.upsertFileMeta(meta);
    },

    deleteFile(path) {
      db.transaction(() => {
        db.deleteChunksByFile(path);
        db.deleteFileMeta(path);
      });
    },

    getFileMeta(path) {
      return db.getFileMeta(path);
    },

    listFiles() {
      return db.listFiles();
    },

    async vectorSearch(qv, topK, filterTags) {
      return finish(db.knnSearch(qv, topK * 4), topK, filterTags);
    },

    async ftsSearch(q, topK, filterTags) {
      return finish(db.ftsSearch(q, topK * 4), topK, filterTags);
    },

    count() {
      return db.countChunks();
    },

    close() {
      db.close();
    },
  };
}
