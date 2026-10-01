/**
 * 壳 2:MCP server,stdio 传输(Claude Code / Cursor 直接配)。
 *
 * 工具面刻意只有两个,保持窄 —— 这是 MCP 的通用纪律:
 *
 *   search_notes   检索:混合召回 + rerank,返回片段原文与出处
 *   reindex_vault  建库:全量/增量同步,返回统计
 *
 * 【关键设计决策】不把「生成答案」做成工具:宿主(Claude/Cursor)自己有模型,
 * search_notes 把片段给它,让它自己读、自己决定要不要追问。检索和生成分开,
 * 宿主模型才有主动权;ask 那条「拼 prompt → 调 LLM」的链路留在 CLI,
 * 给没有宿主模型的场景用。所以这里只调 core.retrieve,永不调 core.ask。
 *
 * stdio 下 stdout 被协议占用:日志一律走 console.error(stderr),
 * 任何 console.log 都会打断协议帧。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildCore } from "../config.js";

async function main(): Promise<void> {
  const { core, config, store } = await buildCore();

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 宿主断开 → stdio 关闭 → 进程退出,这里兜住数据库连接
  // (better-sqlite3 的 close 是同步的,exit 钩子里安全)
  process.on("exit", () => store.close());
  console.error(`obsidian-rag MCP 就绪,vault: ${config.vaultRoot}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
