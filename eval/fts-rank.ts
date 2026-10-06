// 关键词路 BM25F 排名验证:临时库,不碰真实库。
// 对照数据:块 A 的「AOF」只出现在标题列;块 B 的「AOF」在正文出现 2 次。
// 实测:未加权时 B 排在 A 前(tf=2 的饱和值更高);标题 3x 加权后 A 反超。
// 权重一旦被改回等权,这个断言就会失败 —— 它守的是「权重生效」
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVecDb } from "#src/lib/vec-db/index";
import type { VecChunkInput } from "#src/lib/vec-db/index";

const tmp = mkdtempSync(join(tmpdir(), "fts-rank-"));
const db = createVecDb(join(tmp, "test.db"), 4);

/** 组装一个入库块;向量是假数据,本脚本只验证 FTS 路 */
function chunk(file: string, headingPath: string, raw: string): VecChunkInput {
  return {
    file,
    headingPath,
    raw,
    embedText: headingPath ? `${headingPath}\n${raw}` : raw,
    lineFrom: 1,
    lineTo: raw.split("\n").length,
    tags: [],
    links: [],
  };
}

try {
  const vec = new Float32Array([1, 0, 0, 0]);
  db.insertChunk(
    chunk("A.md", "Redis > 持久化 > AOF", "这一节讨论重启后数据恢复的整体流程。"),
    vec,
  );
  db.insertChunk(
    chunk(
      "B.md",
      "Redis > 持久化 > RDB",
      "AOF AOF " + "这一节讨论重启后数据恢复的整体流程。",
    ),
    vec,
  );

  const hits = db.ftsSearch("AOF", 10);
  for (const h of hits) console.log(`${h.file}  [${h.headingPath}]  score=${h.score.toExponential(3)}`);

  const top = hits[0];
  if (top?.file !== "A.md") {
    console.error("FAIL: 标题命中块没有排在正文多词块前面");
    process.exitCode = 1;
  } else {
    console.log("OK: 标题命中块排第一");
  }
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}
