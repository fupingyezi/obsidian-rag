/**
 * Embedder 实现:向量化槽位。
 *
 * 为什么用 openai SDK 而不是各家自己的 SDK:智谱和 DeepSeek 都
 * 提供 OpenAI 兼容端点,一个 SDK 改 baseURL 就能通吃 —— 「换供应商」变成
 * 改一个环境变量的事,和 core 的解耦设计是同一件事。
 *
 * 两个 GOTCHA 在这里落地:
 *   1. 官方两个数字打架(8K 上下文 vs 单条 3072 tokens),按最保守的来:
 *      批大小 64 条。单条长度由 chunk.ts 的 MAX_CHARS=1200 兜底
 *      (约 1800 token),离 3072 还有一倍余量。
 *   2. 维度别一上来就 2048:个人笔记库 1024 维完全够用,
 *      省一半存储和一半比对时间。EMBED_DIM 控制,默认 1024。
 */
import OpenAI from "openai";

import type { Embedder } from "../core/types.js";

const BATCH_SIZE = 64;

// zhipu 的 OpenAI 兼容端点(走 /api/paas/v4):
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export function createEmbedder(cfg: {
  model: string;
  apiKey: string;
  dim: number;
}): Embedder {
  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey: cfg.apiKey,
  });

  const embed = async (texts: string[]) => {
    if (texts.length === 0) return [];

    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await client.embeddings.create({
        model: cfg.model,
        input: batch,
        dimensions: cfg.dim,
      });

      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) {
        vectors.push(new Float32Array(item.embedding));
      }
    }
    return vectors;
  };

  return { dim: cfg.dim, embed };
}
