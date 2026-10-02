/**
 * 查询链路:混合召回 → RRF 融合 → (可选)rerank → 组装结果。
 *
 * 为什么混合:只做向量检索会漏掉精确术语查询 —— 用户搜 `pnid`、
 * `X-Request-Id` 这种标识符时,语义向量往往不如关键词直接。
 *
 * 为什么 RRF:向量分和 BM25 分不在同一个量纲上,直接相加要归一化;
 * RRF 只用两路的「排名」,天然可比 —— 这是它最大的优点。
 */
import type {
  Embedder,
  Reranker,
  ScoredChunk,
  Source,
  Store,
} from "#src/core/types";

// 三个魔法数,实现时直接用作常量:
const RECALL_EACH = 50; //两路召回各取的候选数,个人库足够宽
const RERANK_CANDIDATES = 20; //RRF 融合后保留的候选池宽度,rerank 在这里面挑(「候选 20 取 5」)
const RRF_K = 60; //RRF 常数 k

export async function retrieve(
  deps: {
    embedder: Embedder;
    store: Store;
    rerank?: Reranker; // 配置为 none 时为 undefined,跳过精排
  },
  q: string,
  opts?: { topK?: number; filterTags?: string[] },
): Promise<Source[]> {
  const topK = opts?.topK ?? 5;
  const embed = deps.embedder.embed;
  const store = deps.store;
  const rerank = deps.rerank?.rerank;
  const queryVec =
    (await embed([q]))[0] ?? ({} as Float32Array<ArrayBufferLike>);

  const [vecHits, ftsHits] = await Promise.all([
    store.vectorSearch(queryVec, RECALL_EACH, opts?.filterTags),
    store.ftsSearch(q, RECALL_EACH, opts?.filterTags),
  ]);

  // 候选池宽度
  const poolSize = rerank ? Math.max(topK, RERANK_CANDIDATES) : topK;

  const candidateIds = rrf(
    vecHits.map((t) => t.id),
    ftsHits.map((t) => t.id),
    RRF_K,
    poolSize,
  );

  const hitsById = new Map<number, ScoredChunk>();
  for (const hit of [...vecHits, ...ftsHits]) hitsById.set(hit.id, hit);

  let ranked = candidateIds.map((id) => hitsById.get(id)!);

  if (rerank) {
    // 精排宽度固定为 RERANK_CANDIDATES:topK 超过它时只精排池头(RRF 序),
    // 池尾按原序衔接 —— 任何参数组合下 rerank 不静默失效、不超宽度调用
    const head = ranked.slice(0, RERANK_CANDIDATES);
    const tail = ranked.slice(RERANK_CANDIDATES);
    const docs = head.map((t) => `${t.headingPath}\n${t.raw}`);
    const scores = await rerank(q, docs);
    head.forEach((t, i) => (t.score = scores[i] ?? 0));
    head.sort((x, y) => y.score - x.score);
    ranked = [...head, ...tail];
  }

  const sources = ranked.slice(0, topK).map((t) => ({
    file: t.file,
    headingPath: t.headingPath,
    text: t.raw,
    lineFrom: t.lineFrom,
    lineTo: t.lineTo,
    score: t.score,
  }));

  return sources;
}

/** RRF 函数签名*/
export function rrf(a: number[], b: number[], k = 60, topK = 20): number[] {
  // 实现要点:
  const score = new Map<number, number>();
  const bump = (ids: number[]) =>
    ids.forEach((id, i) =>
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)),
    );

  bump(a);
  bump(b);
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topK)
    .map(([id]) => id);
}
