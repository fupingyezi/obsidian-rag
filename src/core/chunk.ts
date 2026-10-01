/**
 * 分块:按标题层级切。分块策略是这个项目质量的天花板。
 *
 * 为什么不做「固定字数切」:Obsidian 笔记天然带标题层级,H2/H3 是作者
 * 自己划的语义边界,比任何启发式切分都准。分块策略选错了,RAG 从第一天
 * 起就是个残废 —— 而且它不会报错,只会「答得不太对」,
 * 让你以为是自己 prompt 写得不好。
 *
 * 四条切分规则(严格按优先级):
 *   1. 遇 H2 无条件收口上一个块,新块从这里开始;
 *      H1 作文件级上下文(通常全篇一个),出现时也收口并重置
 *   2. 当前块已经达到 maxChars 时,遇 H3 才继续切;否则 H3 并入当前块
 *      —— 即:H2 的整节内容只要没超长,就是一个块
 *   3. 叶子块仍超长时,按空行切段落,贪心凑到 maxChars;
 *      相邻块之间保留 1 个段落的重叠,避免答案正好跨在边界上
 *   4. 单个段落(常见于没有空行的代码块)仍超长时,按字符硬切
 *
 * 关键动作:headingPath 必须拼在正文前一起送 embedding(见 toEmbedText)。
 */
import matter from "gray-matter";

import type { Chunk } from "./types.js";

/** 块长上限(字符)。中文约 1200 字 ≈ 1800 token,给 embedding 单条 token 上限留足余量 */
const MAX_CHARS = 1200;
/** 巨型段落按字符硬切时的窗口重叠(字符) */
const HARD_SPLIT_OVERLAP = 50;

/** 只认 H1~H3;H4 以下级别太深,当正文处理 */
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
/** Obsidian 标签:# 后紧跟非空白字符,所以 "## 标题" 不会被误抓;支持嵌套标签如 #a/b */
const TAG_RE = /#[\p{L}\p{N}_\-/]+/gu;
/**
 * Obsidian 双链,覆盖 [[x]]、[[x|别名]]、[[x#锚]]、[[x#锚|别名]] 四种写法。
 * 替换成展示文本(别名 ?? 目标),同时把目标记进 links。
 */
const LINK_RE = /\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** 一个已定界的文本块:行数组 + 绝对起始行号(1 起,含 frontmatter) */
interface Block {
  lines: string[];
  start: number;
}

/**
 * 解析一个 markdown 文件,返回它切出的全部片段。
 *
 * @param relPath vault 内相对路径(带 .md),进 Chunk.file
 * @param content 文件原文(含 frontmatter)
 * @returns 片段数组;正文为空时返回空数组
 *
 * Obsidian 特有语法的处理方式:
 *   YAML frontmatter → gray-matter 解出,tags 合并进每个块的 tags;
 *   双链 [[x]] → 剥成纯文本进正文,目标进 links;
 *   #tag → 摘出来进 tags,检索时可当过滤器;
 *   Callout > [!note] → 保留标记文本即可,不要费劲转结构;
 *   附件与图片 → 第一版直接跳过。
 */
export function parseFile(relPath: string, content: string): Chunk[] {
  // ── 步骤 1:拆 frontmatter ─────────────────────────────────────────────
  const { data, content: body } = matter(content);
  // frontmatter 占了几行 = 原文件行数 - body 行数,用于把 body 行号换算成文件绝对行号
  const lineOffset = countLines(content) - countLines(body);
  // frontmatter 的 tags 作用于整个文件,合并进每个块(写法可能是数组/字符串/缺失)
  const fmTags = normalizeTags(data.tags);

  // ── 步骤 2:状态机逐行扫描 ──────────────────────────────────────────────
  const lines = body.split("\n");
  const chunks: Chunk[] = [];

  let h1 = ""; // 文件级上下文,通常全篇一个
  let h2 = ""; // 当前 H2
  let curPath = ""; // 当前块的 headingPath —— 块开启时定死,中途遇到不切分的 H3 不变
  let cur: string[] = []; // 当前块累积的行(不含行尾换行)
  let curStart = 0; // 当前块首行的绝对行号
  let accLen = 0; // 当前块字符长度累加器(行长 +1 算换行),避免每次重新 join
  let inFence = false; // 是否在 ``` 代码围栏内 —— 围栏里的 # 和 [[ 都不是 Obsidian 语法

  /** 收口当前块:超长则按段落再切,每个子块生成 Chunk */
  const flush = (): void => {
    if (cur.length === 0) return;
    for (const block of splitOverlong(cur, curStart)) {
      chunks.push(makeChunk(relPath, curPath, block, fmTags));
    }
    cur = [];
    accLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const absLine = i + 1 + lineOffset; // body 第 i 行 → 文件第 absLine 行

    // 围栏切换行:``` 只切换状态,本身保留进正文(展示时不至于丢代码块外壳)。
    // 这个判断必须在 inFence 判断之前,否则识别不出关闭围栏的那一行
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (cur.length === 0) curStart = absLine;
      cur.push(line);
      accLen += line.length + 1;
      continue;
    }
    // 围栏内:不识别标题/标签/双链,原文照收
    if (inFence) {
      if (cur.length === 0) curStart = absLine;
      cur.push(line);
      accLen += line.length + 1;
      continue;
    }

    const hm = HEADING_RE.exec(line);
    if (hm) {
      const level = hm[1]!.length; // 1 = #,2 = ##,3 = ###
      const title = hm[2]!.trim();
      if (level === 1) {
        // H1:文件级上下文。收口旧块,新块路径就是 H1 本身
        flush();
        h1 = title;
        h2 = "";
        curPath = h1;
      } else if (level === 2) {
        // H2:第一级切分点,无条件收口并开新块
        flush();
        h2 = title;
        curPath = joinPath(h1, h2);
      } else if (cur.length > 0 && accLen >= MAX_CHARS) {
        // H3:只有当前块已经达到上限才切,否则并入当前块(块路径保持 H2 层级)
        flush();
        curPath = joinPath(h1, h2, title);
      }
      // 标题行本身进正文(它是块的上下文);flush 后 cur 已空,重新记起点
      if (cur.length === 0) curStart = absLine;
      cur.push(line);
      accLen += line.length + 1;
      continue;
    }

    // 普通行:直接累积(空行也保留,段落切分靠它当边界)
    if (cur.length === 0) curStart = absLine;
    cur.push(line);
    accLen += line.length + 1;
  }
  flush(); // 文件末尾的最后一个块

  return chunks;
}

/**
 * 全项目最关键的一行代码:
 * headingPath 必须进 embedding 输入,不能只进 metadata。
 * 否则「AOF 是什么」这类短问题会命中一堆不相干的片段 ——
 * 因为「AOF」这个术语在正文里可能只出现一次,而上下文全靠标题体现。
 */
export function toEmbedText(c: Chunk): string {
  return c.headingPath ? `${c.headingPath}\n${c.raw}` : c.raw;
}

// ---------------------------------------------------------------- 内部工具

/** 行数(只需相对差值,宽松实现即可) */
function countLines(s: string): number {
  return s.split("\n").length;
}

/** frontmatter tags 字段 → string[](数组 / 逗号字符串 / 缺失 → 空数组) */
function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string")
    return raw
      .split(/[,/]/)
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

/** heading 路径拼接,例:["Redis","持久化","AOF"] → "Redis > 持久化 > AOF" */
function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join(" > ");
}

/** 行数组的字符总长(行间加一个换行,和实际存储一致) */
function charLen(lines: string[]): number {
  let n = 0;
  for (const l of lines) n += l.length + 1;
  return n;
}

/**
 * 把行数组聚成段落:连续非空行为一段,空行是边界。
 * 【行号正确的关键】分隔空行归属到它后面的段落(作前导行),这样所有
 * 段落按顺序拼接能精确还原原始行数组 —— lineTo 才能用
 * start + lines.length - 1 直算,不会因为丢掉空行而偏移。
 */
function collectParagraphs(lines: string[], startLine: number): Block[] {
  const paras: Block[] = [];
  let acc: string[] = [];
  let accStart = startLine;
  let pendingBlanks: string[] = [];
  const push = (): void => {
    if (acc.length > 0) paras.push({ lines: acc, start: accStart });
    acc = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      pendingBlanks.push(line); // 空行先挂起,等下一个非空行决定归属
      continue;
    }
    if (acc.length > 0 && pendingBlanks.length > 0) push(); // 空行分隔 → 前一段收口
    if (acc.length === 0) {
      accStart = startLine + i - pendingBlanks.length; // 起点含前导空行
      acc.push(...pendingBlanks);
    }
    pendingBlanks = [];
    acc.push(line);
  }
  push();
  // 文件末尾的悬挂空行不构成段落,直接丢弃 —— 行号指向最后一行非空内容,更合理
  return paras;
}

/**
 * 超长块的段落级再切分(规则 3/4):
 * 按段落贪心凑到 MAX_CHARS,每开一个新块就回退 1 个段落作重叠。
 * 已知妥协:重叠段 + 后续段落是一次推入,不再二次回检,块长最多超出
 * 一个段落 —— embedding 单条余量(保守 3072 token)足够,不为此复杂化。
 */
function splitOverlong(lines: string[], startLine: number): Block[] {
  const paras = collectParagraphs(lines, startLine);
  const out: Block[] = [];

  let acc: string[] = [];
  let accStart = startLine;
  let accLen = 0;
  let lastPara: Block | null = null; // 上一个收进 acc 的段落,作重叠源

  for (const para of paras) {
    const plen = charLen(para.lines);

    // 单段超长(没有空行的长代码块):先收口已有的,再把这个段落按字符硬切
    if (plen > MAX_CHARS) {
      if (acc.length > 0) out.push({ lines: acc, start: accStart });
      out.push(...hardCut(para));
      acc = [];
      accLen = 0;
      lastPara = null;
      continue;
    }

    // 塞不下:收口当前块,新块从「上一个段落」开始(重叠 1 段)
    if (acc.length > 0 && accLen + plen > MAX_CHARS) {
      out.push({ lines: acc, start: accStart });
      acc = lastPara ? [...lastPara.lines] : [];
      accStart = lastPara ? lastPara.start : para.start;
      accLen = lastPara ? charLen(lastPara.lines) : 0;
    }

    if (acc.length === 0) accStart = para.start;
    acc.push(...para.lines);
    accLen += plen;
    lastPara = para;
  }
  if (acc.length > 0) out.push({ lines: acc, start: accStart });
  return out;
}

/** 巨型段落按字符硬切:窗口 MAX_CHARS、重叠 50 字符,行号按换行数精确换算 */
function hardCut(para: Block): Block[] {
  const text = para.lines.join("\n");
  const out: Block[] = [];
  const step = MAX_CHARS - HARD_SPLIT_OVERLAP;
  for (let pos = 0; pos < text.length; pos += step) {
    const piece = text.slice(pos, pos + MAX_CHARS);
    // 这一段之前有多少个换行,起始行号就往后推多少行
    const newlinesBefore = text.slice(0, pos).split("\n").length - 1;
    out.push({ lines: piece.split("\n"), start: para.start + newlinesBefore });
  }
  return out;
}

/** 从一段原文里提取 #tag(围栏内容已在上层排除) */
function extractTags(raw: string): string[] {
  const found = new Set<string>();
  for (const m of raw.matchAll(TAG_RE)) found.add(m[0]);
  return [...found];
}

/** 剥离 [[双链]] 成展示文本,同时收集目标,返回 [处理后的文本, 目标列表] */
function stripWikiLinks(raw: string): { text: string; links: string[] } {
  const links = new Set<string>();
  const text = raw.replace(LINK_RE, (_m, target: string, alias?: string) => {
    if (target) links.add(target.trim());
    // 展示文本:有别名用别名,否则用目标;[[#锚点]] 这种空目标保原文
    return (alias ?? target).trim() || _m;
  });
  return { text, links: [...links] };
}

/** 从一个定界块生成 Chunk:剥双链、抽标签、合并 frontmatter tags、算行号 */
function makeChunk(file: string, headingPath: string, block: Block, fmTags: string[]): Chunk {
  const rawText = block.lines.join("\n");
  const { text, links } = stripWikiLinks(rawText);
  const tags = [...new Set([...fmTags, ...extractTags(rawText)])];
  return {
    file,
    headingPath,
    raw: text,
    lineFrom: block.start,
    lineTo: block.start + block.lines.length - 1,
    tags,
    links,
  };
}
