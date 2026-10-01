/**
 * 壳 2:MCP server(第 2 周产出,现在只读不写)。
 *
 * 【第 2 周挂壳前的必读:2026-07-28 规范的五个坑】
 * 网上大量 MCP 教程写的是 2024/2025 旧版协议,照抄会直接跑不起来:
 *
 *   ① Sampling 已弃用(SEP-2577):不要设计「server 借宿主客户端的模型生成答案」,
 *     官方建议新实现直接调 LLM provider API —— 正好就是本项目 LLM 槽位在做的事
 *   ② 协议无状态:initialize 握手与 Mcp-Session-Id 请求头已移除;
 *     跨调用状态自己 mint handle 当工具参数传
 *   ③ HTTP 请求头必须带 Mcp-Method(具名工具再加 Mcp-Name);
 *     工具列表返回带 ttlMs 与 cacheScope,客户端可缓存
 *   ④ TypeScript SDK 用 v2,v1.x 是过渡维护轨 —— 现在 package.json 里装的
 *     @modelcontextprotocol/sdk ^1.31 是 v1,挂壳时先升级到 v2 并校正 API 名
 *     (v1 叫 registerTool,v2 的注册函数名可能不同,挂壳时以实际安装版本的 API 为准)
 *   ⑤ 服务端发起请求走 MRTR(多轮往返):server 返回 InputRequiredResult,
 *     client 带着答案重发原请求
 *
 * 顺带:MCP 已于 2025-12-09 捐给 Linux Foundation 的 Agentic AI Foundation,
 * 不再是单一厂商资产 —— 对「值不值得学」是正向信号。
 *
 * 传输层选择:stdio 最省事(Claude Code / Cursor 直接配),
 * Streamable HTTP 是另一个选项 —— 但那是第 2 周的决策,现在不展开。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildCore } from '../config.js';

// ── 骨架:工具面设计(签名照抄,SDK API 按 v2 校正) ──────────────────────
//
// 只注册两个工具,保持工具面尽可能窄 —— 这是 MCP 的一条通用纪律。
// 【关键设计决策】不要把「生成答案」做成工具:search_notes 返回片段,
// 让宿主模型自己读、自己决定要不要追问。检索和生成分开,模型才有主动权。
//
//   server.tool('search_notes',
//     { query: z.string(), limit: z.number().optional() },
//     async (args) => {
//       const hits = await core.retrieve(args.query, { topK: args.limit ?? 5 });
//       return hits.map((h) => ({
//         path: h.file, heading: h.headingPath,
//         text: h.text, score: h.score,
//       }));
//     });
//
//   server.tool('reindex_vault', {}, async () => core.indexVault({ root: VAULT_ROOT }));
//
// ── 启动骨架 ─────────────────────────────────────────────────────────────
//   const { core, config } = buildCore();
//   const server = new McpServer({ name: 'obsidian-rag', version: '1.0.0' });
//   ...注册上面两个工具...
//   const transport = new StdioServerTransport();
//   await server.connect(transport);
//   // stdio 下 stderr 才安全:stdout 被协议占用,任何 console.log 都会打断协议帧。
//   // 日志一律 console.error
//
// ⚠️ 本周(第 1 周)不要碰这个文件,先把 CLI 跑通:
// CLI 是 core 的最薄验证壳,也是 MCP 的调试器

throw new Error('TODO:第 2 周按上方注释实现 MCP server');
