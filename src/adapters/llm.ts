/**
 * LLM 实现:生成槽位。
 *
 * 生成模型和向量化/重排没有任何耦合,可以随时换、按问题难度换 ——
 * 所以它必须做成配置项而不是写死在代码里:接口签名统一成
 * 「输入 prompt、输出文本」,换模型 = 改 .env 里的 LLM_MODEL。
 *
 * DeepSeek 模型名的坑:
 *   deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役,
 *   必须写新名字 deepseek-v4-flash / deepseek-v4-pro。
 *   thinking 与 reasoning_effort 是 V4 才有的参数,旧名不认。
 */
import OpenAI from "openai";

import type { LLM } from "#src/core/types";

// OpenAI 兼容端点表。
const BASE_URLS = {
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  deepseek: "https://api.deepseek.com",
};

export async function createLLM(cfg: {
  provider: "zhipu" | "deepseek";
  model: string;
  apiKey: string;
}): Promise<LLM> {
  const client = new OpenAI({
    baseURL: BASE_URLS[cfg.provider],
    apiKey: cfg.apiKey,
  });

  const chat = async (systemPrompt: string, userPrompt: string) => {
    const response = await client.chat.completions.create({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return response.choices[0]?.message?.content ?? "";
  };

  return { chat };
}
