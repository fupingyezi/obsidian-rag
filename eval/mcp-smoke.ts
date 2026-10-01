// MCP server 冒烟测试:用 SDK client 走完整 stdio 协议拉起 server,
// 验证 listTools → search_notes(真库,只读)→ reindex_vault(全 skip,无 API 调用)。
// 故意用 /tmp 当 cwd —— MCP 宿主就是用任意 cwd 拉进程的,
// .env / DB_PATH 解析必须钉在项目根上,这个测试守住那条不变量
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = "/Users/yoshiko/code/agent/obsidian-rag";

function firstText(r: { content?: unknown }): string {
  const c = r.content as { type: string; text?: string }[] | undefined;
  return c?.[0]?.text ?? "(no text)";
}

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", `${PROJECT}/src/shell/mcp.ts`],
    cwd: "/tmp",
    env: process.env as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("== tools ==", tools.tools.map((t) => t.name).join(", "));

  console.log("== search_notes ==");
  const r1 = (await client.callTool({
    name: "search_notes",
    arguments: { query: "推理框架 六层结构", limit: 3 },
  })) as { isError?: boolean; content?: unknown };
  console.log("isError:", r1.isError === true);
  console.log(firstText(r1).slice(0, 600));

  console.log("== reindex_vault ==");
  const r2 = (await client.callTool({
    name: "reindex_vault",
    arguments: {},
  })) as { isError?: boolean; content?: unknown };
  console.log("isError:", r2.isError === true, "|", firstText(r2));

  await client.close();
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
