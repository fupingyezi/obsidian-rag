/**
 * 壳 1:CLI(第 1 周产出)。core 的最薄验证壳,也是 MCP 的调试器
 * —— 手动跑不通的检索,放进 MCP 只会更难调(MCP 里你看不到中间态)。
 *
 * shell 与 core 的分工:这里才允许 process.argv / console.log。
 * core 的 onUpdate / onError 回调在这里接到 console 上。
 *
 * 依赖 commander。五个命令:
 *   index   全量/增量建库,按 mtime+hash 自动跳过没变的文件;--watch 建完持续监听
 *   ask     一次性提问:检索 + 生成,打印答案与出处(带行号,方便跳回原文)
 *   chat    交互式问答:一个进程连续问,exit / Ctrl-D 退出
 *   watch   监听模式:保存即更新索引(等价 index --watch)
 *   stats   索引统计(片段总数等)
 */
import { createInterface } from "node:readline";

import { Command } from "commander";

import { buildCore } from "../config.js";
import type { Source } from "../core/types.js";

const program = new Command()
  .name("obsidian-rag")
  .description(
    "本地 Obsidian 库 RAG 工具:index 建库,ask 提问,chat 交互问答,watch 实时增量",
  );

// watch 的回调接 console:index --watch 和 watch 命令共用一份
const watchCallbacks = {
  onUpdate: (u: { added: number; updated: number; removed: number; skipped: number }) =>
    console.log(
      `[watch] 新增${u.added} 更新${u.updated} 删除${u.removed} 跳过${u.skipped}`,
    ),
  onError: (err: unknown, rel: string) =>
    console.error(`[watch] ${rel} 处理失败:`, err),
};

program
  .command("index")
  .description("全量/增量建库")
  .option("-w, --watch", "建完后持续监听,保存即更新索引")
  .action(async (opts) => {
    const { core, config, store } = await buildCore();
    const r = await core.indexVault({
      root: config.vaultRoot,
      watch: opts.watch,
      ...watchCallbacks,
    });
    console.log(
      `建库完成:新增 ${r.added},更新 ${r.updated},删除 ${r.removed},跳过 ${r.skipped}`,
    );
    if (!opts.watch) store.close(); // watch 模式下连接要继续用,不能关
  });

program
  .command("ask <question>")
  .description("提问:检索笔记并生成带出处的回答")
  .option("-k, --top-k <n>", "交给生成模型的片段数,默认 5")
  .option("-t, --tags <tags>", "按标签过滤,逗号分隔,例:数据库,面试")
  .action(async (question, opts) => {
    const { core, store } = await buildCore();
    const topK = parseTopK(opts.topK);
    const filterTags = parseTags(opts.tags);
    try {
      const { answer, sources } = await core.ask(question, {
        topK,
        ...(filterTags ? { filterTags } : {}),
      });
      printAnswer(answer, sources);
    } finally {
      store.close();
    }
  });

program
  .command("chat")
  .description("交互式问答:一个进程连续提问,exit / Ctrl-D 退出")
  .option("-k, --top-k <n>", "交给生成模型的片段数,默认 5")
  .option("-t, --tags <tags>", "按标签过滤,逗号分隔,例:数据库,面试")
  .action(async (opts) => {
    const { core, store } = await buildCore();
    const topK = parseTopK(opts.topK);
    const filterTags = parseTags(opts.tags);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "问> ",
    });
    // Ctrl-C 与 Ctrl-D 走同一条退出路径:close 事件 → closed 置位
    rl.on("SIGINT", () => rl.close());

    // 行队列:同一 data 块里的多行、回答期间到达的行,readline 的 question()
    // 都只接得住第一行,其余的直接丢 —— 所以自己排队,逐行消费
    const lines: string[] = [];
    let waiter: ((v: string | null) => void) | null = null;
    let closed = false;

    rl.on("line", (l) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(l);
      } else {
        lines.push(l);
      }
    });
    rl.on("close", () => {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null); // EOF / Ctrl-C 时叫醒等待者,统一退出
      }
    });

    const nextLine = (): Promise<string | null> =>
      new Promise((resolve) => {
        if (lines.length > 0) {
          resolve(lines.shift()!);
          return;
        }
        if (closed) {
          resolve(null);
          return;
        }
        waiter = resolve;
        rl.prompt(); // 只在真等人输入时打提示符,管道批处理不会刷一排
      });

    try {
      console.log("已连接笔记库,输入问题开始;exit / Ctrl-D 退出");
      while (true) {
        const raw = await nextLine();
        if (raw == null) break; // EOF / Ctrl-C
        const line = raw.trim();
        if (!line) continue; // 空行直接重新提示,不打 API
        if (line === "exit" || line === "quit") break;
        try {
          const { answer, sources } = await core.ask(line, {
            topK,
            ...(filterTags ? { filterTags } : {}),
          });
          printAnswer(answer, sources);
        } catch (err) {
          // 单个问题失败(限流/网络抖动)不杀会话,打出来继续问下一个
          console.error(err instanceof Error ? err.message : err);
        }
      }
    } finally {
      rl.close();
      store.close();
    }
  });

program
  .command("watch")
  .description("监听 vault,保存即更新索引")
  .action(async () => {
    const { core, config } = await buildCore();
    await core.indexVault({
      root: config.vaultRoot,
      watch: true,
      ...watchCallbacks,
    });
    console.log("监听中,Ctrl-C 退出");
    await new Promise(() => {}); // 挂住进程,让 chokidar 的事件循环继续
  });

program
  .command("stats")
  .description("索引统计")
  .action(async () => {
    const { store } = await buildCore();
    console.log(`文件 ${store.listFiles().length} 个,片段 ${store.count()} 条`);
    store.close();
  });

// ── ask / chat 共用的小工具 ───────────────────────────────────────────────

/** "-k 5" → 校验过的正整数,缺省 5 */
function parseTopK(raw: string | undefined): number {
  const n = Number(raw ?? 5);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--top-k 需要正整数,收到:${raw}`);
  return n;
}

/** "-t 数据库,面试" → ["数据库", "面试"];没传或全空时 undefined */
function parseTags(raw: string | undefined): string[] | undefined {
  const tags = raw
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);
  return tags?.length ? tags : undefined;
}

/** 答案 + 出处区(文件:起始行 + 标题路径,一条一行) */
function printAnswer(answer: string, sources: Source[]): void {
  console.log(answer);
  if (sources.length > 0) {
    console.log("\n出处:");
    for (const s of sources) {
      console.log(`  ${s.file}:${s.lineFrom}  ${s.headingPath}`);
    }
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  // action 里抛出的错在这里收口:只打 message 不打堆栈,用户不需要看栈
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
