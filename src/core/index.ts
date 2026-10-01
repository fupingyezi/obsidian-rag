/**
 * core 对外契约。整个 core 暴露三个能力:indexVault、ask、retrieve。
 *
 * 边界纪律(判断边界画没画对的唯一标准):本目录不允许出现
 * HTTP / MCP SDK / process.argv / console.log。
 * 依赖的 Embedder / Store / LLM / Reranker 全部由外部注入(config.ts 构造),
 * core 里不 new 任何实现 —— 换供应商 = 改一行构造参数,不是改业务逻辑。
 * 这样 core/ 可以脱离网络和数据库单独做单元测试,这是这个切分最大的回报。
 *
 * retrieve 单独暴露(而不只藏在 ask 内部)是给有宿主模型的壳用的:
 * MCP 场景下宿主自己会读片段、自己生成,只需要检索这一段,不要替它调 LLM。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { watch as chokidarWatch } from "chokidar";

import { parseFile, toEmbedText } from "#src/core/chunk";
import { retrieve } from "#src/core/retrieve";
import type {
  AskResult,
  Embedder,
  FileMeta,
  IndexResult,
  LLM,
  Reranker,
  Source,
  Store,
} from "#src/core/types";

/** 依赖注入:由 config.ts 按环境变量构造好再传进来 */
export interface CoreDeps {
  embedder: Embedder;
  store: Store;
  llm: LLM;
  rerank?: Reranker;
}

/** indexVault 的选项:全量扫描 + 可选的实时增量 */
export interface IndexVaultOpts {
  root: string; // Obsidian 库根目录
  watch?: boolean; // true 时挂 chokidar 做实时增量
  onUpdate?: (r: IndexResult) => void; // watch 下每处理一个文件回调统计,shell 用来打日志
  onError?: (err: unknown, relPath: string) => void; // watch 下单个文件失败时回调
}

/** core 对外的全部能力(契约,签名照抄) */
export interface Core {
  indexVault(opts: IndexVaultOpts): Promise<IndexResult>;

  /** 裸检索,不生成 —— 给自带模型的壳(MCP)用;ask = retrieve + llm.chat */
  retrieve(
    q: string,
    opts?: { topK?: number; filterTags?: string[] },
  ): Promise<Source[]>;

  ask(
    q: string,
    opts?: { topK?: number; filterTags?: string[] },
  ): Promise<AskResult>;
}

export function createCore(deps: CoreDeps): Core {
  return {
    indexVault: (opts) => indexVault(deps, opts),
    retrieve: (q, opts) => retrieve(deps, q, opts),
    ask: (q, opts) => ask(deps, q, opts),
  };
}

// ══════════════════════════ 索引链路:indexVault ══════════════════════════
//
// 流程:fullSync 全量扫描(内含增量判断)→ 若 watch 再挂 watcher。
// watch 模式下 indexVault 在全量完成后即 resolve,watcher 留在后台,
// 后续每个文件经 onUpdate 回报统计 —— 进程靠 chokidar 的句柄保活。

async function indexVault(
  deps: CoreDeps,
  opts: IndexVaultOpts,
): Promise<IndexResult> {
  const result = await fullSync(deps, opts.root);
  if (opts.watch) startWatcher(deps, opts.root, opts.onUpdate, opts.onError);
  return result;
}

/** 递归扫描 .md,返回 Map<相对路径, 绝对路径>,相对路径是 DB 里的主键 */
async function scanMdFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // .obsidian/.trash/.git 与隐藏文件一律跳过
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      // 【踩过的坑】必须白名单只认 .md:黑名单会漏掉各种非笔记文件,
      // 把 .obsidian 里的 JSON 配置当笔记向量化,污染检索结果还很难发现
      if (e.name.endsWith(".md")) out.set(relative(root, abs), abs);
    }
  };
  await walk(root);
  return out;
}

/** 单文件增量判断:跳过 / 只更新元数据 / 重切块,返回统计供累加 */
async function indexOneFile(
  deps: CoreDeps,
  absPath: string,
  relPath: string,
): Promise<IndexResult> {
  const result: IndexResult = { added: 0, updated: 0, removed: 0, skipped: 0 };

  // 一次读取拿到三者:内容 buffer 同时喂 sha256,stat 拿 mtime/size
  const [buf, st] = await Promise.all([readFile(absPath), stat(absPath)]);
  const hash = createHash("sha256").update(buf).digest("hex");
  const meta: FileMeta = { path: relPath, mtimeMs: st.mtimeMs, size: st.size, hash };
  const old = deps.store.getFileMeta(relPath);

  if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) {
    result.skipped += 1; // 绝大多数情况:没动过,最省
    return result;
  }
  if (old && old.hash === hash) {
    deps.store.touchFile(meta); // mtime/size 变了但内容没变,只更新元数据
    result.skipped += 1;
    return result;
  }

  const chunks = parseFile(relPath, buf.toString("utf8"));
  // 文件被清空时 parseFile 返回 [],upsertFile 会删掉该文件全部旧片段
  const vectors = await deps.embedder.embed(chunks.map((c) => toEmbedText(c)));
  deps.store.upsertFile(meta, chunks, vectors);
  if (old) result.updated += 1;
  else result.added += 1;
  return result;
}

/** 全量 = 逐文件 indexOneFile + 反向删除(库里有、磁盘上没有的) */
async function fullSync(deps: CoreDeps, root: string): Promise<IndexResult> {
  const files = await scanMdFiles(root);
  const result: IndexResult = { added: 0, updated: 0, removed: 0, skipped: 0 };

  for (const [relPath, absPath] of files) {
    const r = await indexOneFile(deps, absPath, relPath);
    result.added += r.added;
    result.updated += r.updated;
    result.skipped += r.skipped;
  }

  const onDisk = new Set(files.keys());
  for (const relPath of deps.store.listFiles()) {
    if (!onDisk.has(relPath)) {
      deps.store.deleteFile(relPath);
      result.removed += 1;
    }
  }
  return result;
}

/** chokidar 实时增量:add/change 按文件去抖 3 秒,unlink 立即删除 */
function startWatcher(
  deps: CoreDeps,
  root: string,
  onUpdate?: (r: IndexResult) => void,
  onError?: (err: unknown, relPath: string) => void,
): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = chokidarWatch(root, {
    ignoreInitial: true, // fullSync 已处理过存量,不重放历史事件
    ignored: /(^|[\/\\])\../, // 任何以 . 开头的路径段(隐藏文件/目录)
  });

  const relOf = (p: string): string => relative(root, p);

  const schedule = (relPath: string): void => {
    // Obsidian 保存会连续触发多次事件,合并成一次处理
    const prev = timers.get(relPath);
    if (prev) clearTimeout(prev);
    timers.set(
      relPath,
      setTimeout(async () => {
        timers.delete(relPath);
        try {
          const r = await indexOneFile(deps, join(root, relPath), relPath);
          onUpdate?.(r);
        } catch (err) {
          // 瞬时错误(权限变动、正在写入的瞬间)不杀进程,等下一个事件重试
          onError?.(err, relPath);
        }
      }, 3000),
    );
  };

  watcher.on("add", (p) => schedule(relOf(p)));
  watcher.on("change", (p) => schedule(relOf(p)));
  watcher.on("unlink", (p) => {
    const relPath = relOf(p);
    const timer = timers.get(relPath);
    if (timer) clearTimeout(timer); // 挂起的重索引已无意义
    timers.delete(relPath);
    try {
      deps.store.deleteFile(relPath);
      onUpdate?.({ added: 0, updated: 0, removed: 1, skipped: 0 });
    } catch (err) {
      onError?.(err, relPath);
    }
  });
  // watcher 级错误(如整个目录被删):没有具体文件,给空路径,不让进程崩掉
  watcher.on("error", (err) => onError?.(err, ""));
}

// ══════════════════════════ 查询链路:ask ══════════════════════════
//
// 流程:retrieve(检索)→ 组装 prompt → llm.chat(生成)。

/** system prompt:角色设定 + 引用纪律,这类工具的命门 */
const SYSTEM_PROMPT = [
  "你是个人笔记库的检索问答助手,严格遵循以下纪律:",
  "1. 只依据提供的笔记片段回答,不要编造片段之外的事实;",
  "2. 引用出处时注明「文件路径 > 所在小节」;",
  "3. 片段不足以回答时,直说「笔记中没有相关记录」,不要硬凑答案。",
].join("\n");

async function ask(
  deps: CoreDeps,
  q: string,
  opts?: { topK?: number; filterTags?: string[] },
): Promise<AskResult> {
  const sources = await retrieve(deps, q, opts);

  // 空检索的边界:别把空 prompt 丢给模型
  if (sources.length === 0) {
    return { answer: "笔记中没有相关记录。", sources: [] };
  }

  const excerpts = sources
    .map((s, i) => `[片段 ${i + 1}] ${s.file} > ${s.headingPath}\n${s.text}`)
    .join("\n\n");

  const answer = await deps.llm.chat(
    SYSTEM_PROMPT,
    `【笔记片段】\n${excerpts}\n\n【问题】\n${q}`,
  );
  return { answer, sources };
}
