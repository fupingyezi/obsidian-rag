/**
 * 配置层:读环境变量 → 构造三个槽位的 adapter → 注入 core。
 * 这是「依赖注入」的落点:core 里不 new 任何实现,
 * 换供应商 = 改 .env 一个变量,业务逻辑零改动。
 *
 * 三个槽位分别配置、互不影响:
 *   EMBED_*   向量化(固定 zhipu)
 *   RERANK_*  重排(zhipu | none)
 *   LLM_*     生成(zhipu | deepseek)
 */
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { createEmbedder } from "./adapters/embed.js";
import { createLLM } from "./adapters/llm.js";
import { createReranker } from "./adapters/rerank.js";
import { createStore } from "./adapters/store.js";
import { createCore } from "./core/index.js";
import type { Core } from "./core/index.js";
import type { Store } from "./core/types.js";

// .env 与相对 DB_PATH 一律以项目根为基准,不随进程 cwd 漂移 ——
// MCP 宿主会用任意 cwd 拉起本进程,cwd 相对路径会悄悄建出第二个空库
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// 字段与 .env.example 一一对应;个人库 1024 维是甜点位,省一半存储和比对时间
const EnvSchema = z.object({
  EMBED_MODEL: z.string().default("embedding-3"),
  EMBED_DIM: z.coerce.number().int().min(256).max(2048).default(1024),
  RERANK_PROVIDER: z.enum(["zhipu", "none"]).default("none"),
  RERANK_MODEL: z.string().default("rerank"),
  LLM_PROVIDER: z.enum(["zhipu", "deepseek"]).default("zhipu"),
  LLM_MODEL: z.string().default("GLM-4.7-Flash"),
  ZHIPU_API_KEY: z.string().default(""),
  DEEPSEEK_API_KEY: z.string().default(""),
  VAULT_ROOT: z.string().default(""),
  DB_PATH: z.string().default(".data/rag.db"),
});

export interface AppConfig {
  embedModel: string;
  embedDim: number;
  embedApiKey: string;
  rerankProvider: "zhipu" | "none";
  rerankModel: string;
  /** provider 为 none 时是空串,不会被用到 */
  rerankApiKey: string;
  llmProvider: "zhipu" | "deepseek";
  llmModel: string;
  llmApiKey: string;
  vaultRoot: string;
  dbPath: string;
}

export function loadConfig(): AppConfig {
  try {
    process.loadEnvFile(join(PROJECT_ROOT, ".env"));
  } catch {
    // 项目根没有 .env 时再看进程 cwd(老用法);两处都没有就只用真实
    // 环境变量 —— 便于部署时由外部注入。
    // 环境变量永远优先:loadEnvFile 不覆盖已存在的变量
    try {
      process.loadEnvFile();
    } catch {
      // 两处都没有 .env,静默跳过
    }
  }
  const env = EnvSchema.parse(process.env);

  // 缺失校验:在这里抛带操作提示的错,别让 adapter 拿着空 key 去请求,
  // 那样只会得到一个 401,看不出是哪个槽位配置漏了
  if (!env.ZHIPU_API_KEY)
    throw new Error(
      "ZHIPU_API_KEY 未配置 —— 向量化槽位固定 zhipu,必填(参考 .env.example)",
    );
  if (env.LLM_PROVIDER === "deepseek" && !env.DEEPSEEK_API_KEY)
    throw new Error("LLM_PROVIDER 选择了 deepseek,但 DEEPSEEK_API_KEY 未配置");
  if (!env.VAULT_ROOT)
    throw new Error("VAULT_ROOT 未配置 —— 请在 .env 里填 Obsidian 库根目录的绝对路径");

  return {
    embedModel: env.EMBED_MODEL,
    embedDim: env.EMBED_DIM,
    embedApiKey: env.ZHIPU_API_KEY,
    rerankProvider: env.RERANK_PROVIDER,
    rerankModel: env.RERANK_MODEL,
    rerankApiKey: env.RERANK_PROVIDER === "zhipu" ? env.ZHIPU_API_KEY : "",
    llmProvider: env.LLM_PROVIDER,
    llmModel: env.LLM_MODEL,
    llmApiKey:
      env.LLM_PROVIDER === "deepseek" ? env.DEEPSEEK_API_KEY : env.ZHIPU_API_KEY,
    vaultRoot: env.VAULT_ROOT,
    dbPath: isAbsolute(env.DB_PATH)
      ? env.DB_PATH
      : join(PROJECT_ROOT, env.DB_PATH),
  };
}

/**
 * 组装整个应用:三个 adapter + 注入 core。
 * 每次调用都新建连接 —— CLI 是短命进程,用完即弃,不需要连接池。
 */
export async function buildCore(): Promise<{
  core: Core;
  config: AppConfig;
  /** stats 命令要看库,一并返回;关闭时机由调用方掌握 */
  store: Store;
}> {
  const config = loadConfig();

  const embedder = createEmbedder({
    model: config.embedModel,
    apiKey: config.embedApiKey,
    dim: config.embedDim,
  });

  // 建表维度取自 embedder.dim 而不是环境变量 —— 单一事实来源,
  // 改 EMBED_DIM 时建表与向量两处永远一致
  const store = createStore(config.dbPath, embedder.dim);

  const llm = await createLLM({
    provider: config.llmProvider,
    model: config.llmModel,
    apiKey: config.llmApiKey,
  });

  const rerank = createReranker({
    provider: config.rerankProvider,
    model: config.rerankModel,
    apiKey: config.rerankApiKey,
  });

  const core = createCore({
    embedder,
    store,
    llm,
    ...(rerank ? { rerank } : {}), // exactOptionalPropertyTypes 下别传 undefined
  });

  return { core, config, store };
}
