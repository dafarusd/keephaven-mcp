#!/usr/bin/env node
// keephaven-mcp: an MCP server that gives an agent a memory living on its human's Keephaven box.
//
//   KEEPHAVEN_URL=http://keephaven-xxxx.local:8790 KEEPHAVEN_TOKEN=khm_... npx -y github:dafarusd/keephaven-mcp
//
// The owner creates the token in Keephaven's Settings > Agents. The agent sees only its own folder.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KeephavenError, KeephavenMemory } from "./client.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `This server is your long-term memory. It lives on a Keephaven box in your human's home, not on a vendor's server, and it survives your sessions, your context window and your platform.

How to use it well:
- At the start of a session, call journal_read for what you did recently, and memory_search for anything about the task at hand.
- Keep durable facts as small files: memory_write("people/<name>.md"), ("projects/<name>.md"), ("preferences.md"). Overwrite them as they change; pass the etag from memory_read to avoid clobbering a newer copy.
- Log what you did and decided with journal_append. The journal is append-only: you can add to it, never change or delete it. It's the record your future self can trust.
- Your human owns the box. They can see what you store, revoke you, or delete your folder. Don't store their passwords or keys here.`;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function fail(e: unknown) {
  const msg = e instanceof KeephavenError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Keephaven: ${msg}` }], isError: true };
}

function buildServer(mem: KeephavenMemory): McpServer {
  const server = new McpServer({ name: "keephaven-memory", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "memory_status",
    {
      title: "Memory status",
      description: "Who you are on this Keephaven, whether you can write, and how much of your quota is used.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const m = await mem.me();
        const mb = (n: number) => (n / 1048576).toFixed(1);
        return text(
          `agent ${m.agent}${m.read_only ? " (read only)" : ""}: ${m.files} files, ${mb(m.used_bytes)} of ${mb(m.quota_bytes)} MB used, last write ${m.last_write ?? "never"}`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memory files",
      description: "List the files in your memory, optionally under a folder prefix like 'people' or 'projects/keephaven'.",
      inputSchema: { prefix: z.string().max(512).optional().describe("folder to list, e.g. 'people'") },
      annotations: { readOnlyHint: true },
    },
    async ({ prefix }) => {
      try {
        const files = await mem.list(prefix ?? "");
        if (!files.length) return text(prefix ? `nothing under ${prefix}` : "your memory is empty");
        return text(files.map((f) => `${f.path}  ${f.size} bytes  ${f.mtime}`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory file",
      description: "Read one file from your memory. Returns its text and an etag; pass the etag to memory_write to avoid overwriting a newer copy.",
      inputSchema: { path: z.string().min(1).max(512).describe("e.g. 'people/dafarus.md'") },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      try {
        const r = await mem.read(path);
        if (r.text === null) return text(`etag: ${r.etag}\n(binary, ${r.size} bytes, base64)\n${r.base64}`);
        return text(`etag: ${r.etag}\n---\n${r.text}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write a memory file",
      description:
        "Create or replace one file in your memory (UTF-8 text, up to 10 MB). Paths are plain segments of letters, digits, _ . - separated by '/'. journal/ is not writable here: use journal_append.",
      inputSchema: {
        path: z.string().min(1).max(512).describe("e.g. 'projects/keephaven.md'"),
        content: z.string().describe("the whole new content of the file"),
        if_match: z.string().optional().describe("etag from memory_read; the write fails if the file changed since"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ path, content, if_match }) => {
      try {
        const r = await mem.write(path, content, if_match);
        return text(`saved ${r.path} (${r.size} bytes), etag ${r.etag}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a memory file",
      description: "Delete one file from your memory on the box. Journal files can't be deleted. A paired backup box keeps what it already received.",
      inputSchema: { path: z.string().min(1).max(512) },
      annotations: { destructiveHint: true },
    },
    async ({ path }) => {
      try {
        await mem.remove(path);
        return text(`deleted ${path}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "journal_append",
    {
      title: "Add to your journal",
      description:
        "Append one entry to your append-only journal: what you did, decided, or learned. Nothing in the journal can be edited or deleted afterwards, so it's the record your future sessions can trust.",
      inputSchema: {
        text: z.string().min(1).max(16000).describe("what happened, in a sentence or two"),
        tags: z.array(z.string().max(64)).max(20).optional(),
        data: z.record(z.string(), z.unknown()).optional().describe("any structured detail: ids, numbers, results"),
      },
      annotations: { idempotentHint: false },
    },
    async ({ text: t, tags, data }) => {
      try {
        const r = await mem.journalAppend({ text: t, ...(tags ? { tags } : {}), ...(data ? { data } : {}) });
        return text(`journal entry ${r.seq} added to ${r.file}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "journal_read",
    {
      title: "Read your journal",
      description: "Read your most recent journal entries, oldest first. Use at the start of a session to pick up where you left off.",
      inputSchema: {
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD, only entries from this day on"),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, limit }) => {
      try {
        const es = await mem.journalRead(since ?? "", limit ?? 50);
        if (!es.length) return text("the journal is empty");
        return text(es.map((e) => `#${e.seq} ${e.ts} ${JSON.stringify(e.entry)}`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search your memory",
      description: "Case-insensitive text search across your memory files and journal. Returns matching lines with file and line number.",
      inputSchema: {
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        const hits = await mem.search(query, limit ?? 20);
        if (!hits.length) return text(`nothing matches "${query}"`);
        return text(hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

async function main() {
  const url = process.env.KEEPHAVEN_URL;
  const token = process.env.KEEPHAVEN_TOKEN;
  if (!url || !token) {
    process.stderr.write(
      "keephaven-mcp: set KEEPHAVEN_URL (e.g. http://keephaven-xxxx.local:8790) and KEEPHAVEN_TOKEN (from Settings > Agents on the box)\n",
    );
    process.exit(2);
  }
  const server = buildServer(new KeephavenMemory(url, token));
  await server.connect(new StdioServerTransport());
}

// Always run. A "was I started directly?" check breaks on Windows, where npm's shim passes a
// backslash path that never matches import.meta.url, so the server would start and do nothing.
main().catch((e) => {
  process.stderr.write(`keephaven-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
