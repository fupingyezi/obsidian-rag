/**
 * 数据库实例:目录、连接、pragma、sqlite-vec 扩展、执行 DDL。
 *
 * 为什么是 sqlite-vec:它只是一个 SQLite 扩展 —— 向量和笔记元数据在
 * 同一个 .db 文件里,用 where 过滤标签、join 回查原文,备份就是 cp 一个文件。
 * 个人库几万段以内,它的暴力 KNN 是毫秒级;稳定版没有 ANN 索引,纯暴力扫描,
 * 换来完美召回和零索引损坏风险。拐点在百万级向量以上,到那时换 LanceDB,
 * 只需新写一个实现,上层 store 不动。
 *
 * 语句与业务操作见 index.ts,表结构见 schema.ts。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { schemaSql } from "#src/lib/vec-db/schema";

/** 打开并初始化向量库(幂等,可重复调用):建目录 → 开连接 → pragma → 加载扩展 → 建表 */
export function openDb(dbPath: string, dim: number): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true }); // 父目录不存在时 better-sqlite3 直接抛错
  const db = new Database(dbPath);
  db.pragma("journal_mode = wal"); // watch 增量写与查询并发互不阻塞
  db.pragma("busy_timeout = 5000"); // 并发写竞争时等待而不是直接报错
  sqliteVec.load(db); // 加载平台对应的 .dylib/.so,之后才能建 vec0 虚拟表
  db.exec(schemaSql(dim));
  return db;
}
