/**
 * 壳 2:MCP server。一套工具,三种传输:
 *
 *   默认(stdio)             本地宿主拉子进程:Claude Code / Cursor / deepresearch 的「stdio」
 *   --http [--port N] [--host H]  HTTP 服务,同一端口挂两个端点:
 *     /mcp   Streamable HTTP(现行远程协议,无会话)
 *     /sse   旧版 SSE(老客户端;deepresearch 的「sse(远程)」选项)
 *
 * 工具面刻意只有两个,保持窄 —— 这是 MCP 的通用纪律:
 *
 *   search_notes   检索:混合召回 + rerank,返回片段原文与出处
 *   reindex_vault  建库:全量/增量同步,返回统计
 *
 * 【关键设计决策】不把「生成答案」做成工具:宿主自己有模型,search_notes
 * 把片段给它,让它自己读、自己决定要不要追问。检索和生成分开,宿主模型才有
 * 主动权;ask 那条「拼 prompt → 调 LLM」的链路留在 CLI,给没有宿主模型的场景用。
 *
 * 日志一律 console.error:stdio 模式下 stdout 被协议占用,任何 console.log
 * 都会打断协议帧;HTTP 模式没有这个约束,但保持同一条日志通道,行为一致。
 *
 * HTTP 模式默认只绑 127.0.0.1 —— 这是个人笔记库的检索口,不该暴露到网络;
 * 确要局域网访问时 --host 0.0.0.0 自己承担。
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { buildCore } from "#src/config";
import type { AppConfig } from "#src/config";
import type { Core } from "#src/core/index";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * 每种传输各自 new McpServer(HTTP 无会话模式甚至每请求一个),
 * 工具注册必须收进工厂 —— core/store 是进程级单例,闭包共享,注册本身零成本。
 */
function buildMcpServer(core: Core, config: AppConfig): McpServer {
  const server = new McpServer({ name: "obsidian-rag", version: "1.0.0" });

  server.registerTool(
    "search_notes",
    {
      title: "检索笔记",
      description:
        "在用户的 Obsidian 笔记库里检索:语义 + 关键词混合召回并重排," +
        "返回最相关片段的原文与出处(文件路径:行号 + 标题路径)。" +
        "回答用户关于其个人笔记的问题前,先用它找依据;",
      inputSchema: {
        query: z.string().describe("检索词或问题,自然语言或精确术语都可以"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("返回片段数,默认 5"),
        tags: z
          .array(z.string())
          .optional()
          .describe("按标签过滤(片段需包含全部标签),不确定标签就别传"),
      },
    },
    async ({ query, limit, tags }) => {
      try {
        const hits = await core.retrieve(query, {
          topK: limit ?? 5,
          ...(tags ? { filterTags: tags } : {}),
        });
        // 分数不输出:不开 rerank 时它是 RRF 占位值,打出来只会误导宿主
        const text =
          hits.length === 0
            ? "没有命中任何片段"
            : hits
                .map(
                  (h, i) =>
                    `[${i + 1}] ${h.file}:${h.lineFrom}  ${h.headingPath}\n${h.text}`,
                )
                .join("\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        // 检索失败(限流/网络)不抛协议错误:以 isError 结果返回,
        // 宿主模型看得见失败原因,可以决定重试还是换个问法
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `检索失败:${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "reindex_vault",
    {
      title: "同步索引",
      description:
        "扫描笔记库做增量同步(按 mtime + hash 跳过没变的文件)。" +
        "用户新建/修改/删除笔记后、或 search_notes 结果明显过时时调用",
    },
    async () => {
      try {
        const r = await core.indexVault({ root: config.vaultRoot });
        return {
          content: [
            {
              type: "text",
              text: `同步完成:新增 ${r.added},更新 ${r.updated},删除 ${r.removed},跳过 ${r.skipped}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `同步失败:${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

// ══════════════════════════ 入口:按 argv 选传输 ══════════════════════════

async function main(): Promise<void> {
  const { core, config, store } = await buildCore();
  // 进程退出(宿主收进程 / Ctrl-C / HTTP 模式 kill)时兜住数据库连接,
  // better-sqlite3 的 close 是同步的,exit 钩子里安全
  process.on("exit", () => store.close());

  const opts = parseArgs(process.argv.slice(2));
  if (opts.http) {
    serveHttp(core, config, opts.port, opts.host);
  } else {
    await serveStdio(core, config);
  }
}

/** 只认三个旗标,不值得为此引 commander */
function parseArgs(argv: string[]): {
  http: boolean;
  port: number;
  host: string;
} {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(valueOf("--port") ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`--port 需要有效端口号,收到:${valueOf("--port")}`);
  return {
    http: argv.includes("--http"),
    port,
    host: valueOf("--host") ?? "127.0.0.1",
  };
}

// ══════════════════════════ 传输 1:stdio ══════════════════════════

async function serveStdio(core: Core, config: AppConfig): Promise<void> {
  const server = buildMcpServer(core, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`obsidian-rag MCP(stdio)就绪,vault: ${config.vaultRoot}`);
}

// ══════════════════════════ 传输 2/3:Streamable HTTP + 旧版 SSE ══════════════════════════

function serveHttp(
  core: Core,
  config: AppConfig,
  port: number,
  host: string,
): void {
  // SDK 自带的 express 工厂:localhost 绑定时自动挂 DNS 重绑定防护
  const app = createMcpExpressApp({ host });
  app.use(express.json());

  // ── /mcp:Streamable HTTP,无会话模式 ──
  // 每个请求独立一套 server + transport,用完即弃:没有会话状态要维护,
  // 也就没有「会话失效重连」这类问题;代价是每次握手重跑工具注册,零成本。
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildMcpServer(core, config);
      // 省略 sessionIdGenerator 即无会话模式;不显式传 undefined 是因为
      // exactOptionalPropertyTypes 拦「可选属性显式 undefined」
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => {
        transport.close();
        server.close();
      });
      // SDK 这个实现的回调是 getter/setter 声明(写类型带 undefined),
      // exactOptionalPropertyTypes 下与 Transport 接口结构不符,桥接一层
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // 兜底:协议内的错误 transport 自己会回;这里只接协议外炸的
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err) },
          id: null,
        });
    }
  });
  // 无会话模式下这两个动词没有意义:GET 只用于服务端主动推送,DELETE 只用于断会话
  app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
  app.delete("/mcp", (_req, res) =>
    res.status(405).send("Method Not Allowed"),
  );

  // ── /sse + /messages:旧版 SSE 传输(2025-03 之前的客户端)──
  // 有连接态:GET /sse 建立长连接拿 sessionId,之后的请求全走 POST /messages。
  // 连接断开(页面刷新/客户端退出)时清掉条目,session 不泄漏
  const sseSessions = new Map<
    string,
    { transport: SSEServerTransport; server: McpServer }
  >();

  app.get("/sse", async (_req, res) => {
    const server = buildMcpServer(core, config);
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, { transport, server });
    res.on("close", () => {
      sseSessions.delete(transport.sessionId);
      server.close();
    });
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sid = req.query.sessionId;
    const entry = typeof sid === "string" ? sseSessions.get(sid) : undefined;
    if (!entry) {
      res.status(404).end("Unknown session");
      return;
    }
    await entry.transport.handlePostMessage(req, res, req.body);
  });

  app.listen(port, host, () => {
    console.error(`obsidian-rag MCP(HTTP)就绪,vault: ${config.vaultRoot}`);
    console.error(`  streamable http  http://${host}:${port}/mcp`);
    console.error(`  sse(旧版)       http://${host}:${port}/sse`);
    console.error(`  Ctrl-C 退出`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
