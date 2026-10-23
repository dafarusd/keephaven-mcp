// End to end: the real Keephaven memory server (Python, from the Keephaven repo) on a random port,
// this package's built MCP server spawned over stdio, and the official MCP client calling its tools.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = process.env.KEEPHAVEN_SERVER ?? join(process.env.HOME ?? "", "cloud-image/modules/agent-memory.py");

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => ok(typeof a === "object" && a ? a.port : 0));
    });
  });
}

function textOf(r: unknown): string {
  const c = (r as { content: { type: string; text: string }[] }).content;
  return c.map((x) => x.text).join("\n");
}

let py: ChildProcess;
let client: Client;
let other: Client;
let url = "";

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(__dirname, "..", "dist", "index.js")],
      env: { ...process.env, KEEPHAVEN_URL: url, KEEPHAVEN_TOKEN: token } as Record<string, string>,
    }),
  );
  return c;
}

describe.skipIf(!existsSync(SERVER))("keephaven-mcp against the real memory server", () => {
  beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), "khm-"));
    const add = (n: string) => execFileSync("python3", [SERVER, "add", "--data", data, n], { encoding: "utf8" }).trim();
    const tokA = add("scout");
    const tokB = add("other");
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    py = spawn("python3", [SERVER, "serve", "--data", data, "--bind", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(url + "/v1/health")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    client = await connect(tokA);
    other = await connect(tokB);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await other?.close();
    py?.kill();
  });

  it("lists the eight tools and carries instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["journal_append", "journal_read", "memory_delete", "memory_list", "memory_read", "memory_search", "memory_status", "memory_write"].sort(),
    );
    expect(client.getInstructions()).toContain("append-only");
  });

  it("writes, reads back with an etag, and refuses a stale etag", async () => {
    const w = textOf(await client.callTool({ name: "memory_write", arguments: { path: "people/dafarus.md", content: "builds Keephaven" } }));
    expect(w).toMatch(/saved people\/dafarus\.md \(16 bytes\)/);
    const r = textOf(await client.callTool({ name: "memory_read", arguments: { path: "people/dafarus.md" } }));
    expect(r).toContain("builds Keephaven");
    const etag = /etag: (".*?")/.exec(r)?.[1] ?? "";
    await client.callTool({ name: "memory_write", arguments: { path: "people/dafarus.md", content: "v2", if_match: etag } });
    const stale = await client.callTool({ name: "memory_write", arguments: { path: "people/dafarus.md", content: "v3", if_match: etag } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("412");
  });

  it("journals append-only and reads it back in order", async () => {
    await client.callTool({ name: "journal_append", arguments: { text: "first", tags: ["t"] } });
    await client.callTool({ name: "journal_append", arguments: { text: "second", data: { n: 2 } } });
    const j = textOf(await client.callTool({ name: "journal_read", arguments: {} }));
    expect(j.indexOf('"first"')).toBeLessThan(j.indexOf('"second"'));
    const del = await client.callTool({ name: "memory_delete", arguments: { path: `journal/${new Date().toISOString().slice(0, 10)}.jsonl` } });
    expect(del.isError).toBe(true);
  });

  it("searches, lists, reports status", async () => {
    expect(textOf(await client.callTool({ name: "memory_search", arguments: { query: "SECOND" } }))).toContain("journal/");
    expect(textOf(await client.callTool({ name: "memory_list", arguments: { prefix: "people" } }))).toContain("people/dafarus.md");
    expect(textOf(await client.callTool({ name: "memory_status", arguments: {} }))).toMatch(/^agent scout: \d+ files/);
  });

  it("keeps agents apart", async () => {
    const r = await other.callTool({ name: "memory_read", arguments: { path: "people/dafarus.md" } });
    expect(r.isError).toBe(true);
    expect(textOf(await other.callTool({ name: "memory_search", arguments: { query: "keephaven" } }))).toContain("nothing matches");
  });

  it("reports a bad path as a tool error, not a crash", async () => {
    const r = await client.callTool({ name: "memory_write", arguments: { path: "../escape.md", content: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("bad path");
  });
});

describe("keephaven-mcp without a reachable box", () => {
  it("says it can't reach the box instead of crashing", async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    const c = await connect("khm_nobody");
    const r = await c.callTool({ name: "memory_status", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("can't reach the Keephaven");
    await c.close();
  });
});
