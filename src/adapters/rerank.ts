/**
 * Rerank 实现:重排槽位。
 *
 * 为什么值得做:RAG 的质量瓶颈通常在「召回了 20 条、正确答案排在第 9 位」。
 * Rerank 是把候选集重新排序的那一步,成本低(每次查询几厘钱)、收益直接,
 * 是这个项目里最划算的一次投入 —— 但建议先把链路跑通,用评测题确认
 * 它对你的库确实有增益之后再开(用 eval/questions.md 里的题:开关 rerank
 * 各跑一遍比前 3 命中数)。
 *
 * 供应商:zhipu 的 rerank。用裸 fetch 调用
 * (rerank 接口不是 OpenAI Chat 格式,openai SDK 用不上)。
 *
 * 注意:这个接口的分数分布高度压缩 —— 不相关的文档也能打到 0.99+,
 * 绝对分数不能当「相关/不相关」的阈值用,只有相对排序有意义。
 *
 */
import type { Reranker } from "../core/types.js";

/**
 * 按配置构造 Reranker。
 * provider 为 'none' 时返回 undefined —— retrieve.ts 检测到没有 rerank
 * 就直接用 RRF 融合结果取 topK(第一版推荐这样起步)。
 */
export function createReranker(cfg: {
  provider: "zhipu" | "none";
  model: string;
  apiKey: string;
}): Reranker | undefined {
  const reranker = async (query: string, docs: string[]) => {
    if (docs.length <= 1) return docs.map(() => 1); // 单个候选无需排序

    const body = {
      model: cfg.model,
      query: query,
      documents: docs,
    };

    const response = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/rerank",
      {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "post",
      },
    );

    // 失败必须抛出来:静默吞掉的话 rerank 就退化成全 0 分的空转,排序原地不动,
    // 而且从外面完全看不出来 —— 这套代码之前就是这么静默失效的
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `rerank 请求失败:${response.status} ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      results?: { index: number; relevance_score: number }[];
    };

    const scores = new Array<number>(docs.length).fill(0);
    for (const r of data.results ?? []) {
      scores[r.index] = r.relevance_score;
    }

    return scores;
  };

  switch (cfg.provider) {
    case "none":
      return undefined;
    case "zhipu": {
      return { rerank: reranker };
    }
  }
}
