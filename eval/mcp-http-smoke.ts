// MCP HTTP 冒烟测试:拉起 `mcp.ts --http`,验证同一端口上的两套端点 ——
//   Streamable HTTP(/mcp,现行协议)→ listTools + search_notes(真库,只读)
//   旧版 SSE(/sse)→ listTools + reindex_vault(全 skip,无 API 调用)
// 子进程 cwd 故意用 /tmp:守住「配置解析钉在项目根」的不变量
import { spawn, type ChildProcess } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const PROJECT = "/Users/yoshiko/code/agent/obsidian-rag";
const PORT = 3399;

function firstText(r: unknown): string {
  const c = (r as { content?: unknown }).content as
    | { type: string; text?: string }[]
    | undefined;
  return c?.[0]?.text ?? "(no text)";
}

async function waitReady(): Promise<void> {
  // GET /mcp 返回 405 = express 已就绪(405 是我们给无会话模式的明确答复)
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`);
      if (res.status === 405) return;
    } catch {
      // 还没起来,继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server 60s 内没就绪");
}

async function main() {
  const child: ChildProcess = spawn(
    `${PROJECT}/node_modules/.bin/tsx`,
    [`${PROJECT}/src/shell/mcp.ts`, "--http", "--port", String(PORT)],
    { cwd: "/tmp", env: process.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  child.stdout?.on("data", () => {}); // 不该有 stdout 输出;有也不堵管道

  try {
    await waitReady();

    console.log("== Streamable HTTP (/mcp) ==");
    const http = new Client({ name: "http-smoke", version: "0.0.0" });
    // 客户端侧同款类型坑:sessionId getter 带 undefined,
    // exactOptionalPropertyTypes 下与 Transport 接口不符,桥接一层
    await http.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
      ) as unknown as Transport,
    );
    const tools1 = await http.listTools();
    console.log("tools:", tools1.tools.map((t) => t.name).join(", "));
    const r1 = await http.callTool({
      name: "search_notes",
      arguments: { query: "推理框架 六层结构", limit: 2 },
    });
    console.log("isError:", (r1 as { isError?: boolean }).isError === true);
    console.log(firstText(r1).slice(0, 300));
    await http.close();

    console.log("== 旧版 SSE (/sse) ==");
    const sse = new Client({ name: "sse-smoke", version: "0.0.0" });
    await sse.connect(
      new SSEClientTransport(new URL(`http://127.0.0.1:${PORT}/sse`)),
    );
    const tools2 = await sse.listTools();
    console.log("tools:", tools2.tools.map((t) => t.name).join(", "));
    const r2 = await sse.callTool({
      name: "reindex_vault",
      arguments: {},
    });
    console.log("isError:", (r2 as { isError?: boolean }).isError === true, "|", firstText(r2));
    await sse.close();
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
