// A small client for the Keephaven agent memory API (modules/agent-memory.py in the Keephaven repo).

export class KeephavenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FileInfo {
  path: string;
  size: number;
  mtime: string;
}

export interface JournalEntry {
  ts: string;
  seq: number;
  entry: Record<string, unknown>;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface Me {
  agent: string;
  read_only: boolean;
  quota_bytes: number;
  used_bytes: number;
  files: number;
  last_write: string | null;
}

export class KeephavenMemory {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {
    this.base = url.replace(/\/+$/, "");
  }

  private async call(method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        body,
        headers: { Authorization: `Bearer ${this.token}`, ...headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new KeephavenError(0, `can't reach the Keephaven at ${this.base} (${why}). Is the box on, and is this machine on its network or tailnet?`);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = `${res.status}: ${j.error}`;
      } catch {
        /* not JSON */
      }
      throw new KeephavenError(res.status, msg);
    }
    return res;
  }

  // Same rule as the server: plain segments of letters, digits, _ . - (no leading dot), at most 512 chars.
  // Checked here too because fetch() collapses "..", which would turn a bad path into a confusing 404.
  static encodePath(p: string): string {
    const segs = p.split("/");
    if (!p || p.length > 512 || segs.some((s) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(s))) {
      throw new KeephavenError(400, `bad path "${p}": use plain segments of letters, digits, _ . - separated by "/", like "people/dafarus.md"`);
    }
    return segs.map((s) => encodeURIComponent(s)).join("/");
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    return (await (await this.call("GET", "/v1/health")).json()) as { ok: boolean; version: string };
  }

  async me(): Promise<Me> {
    return (await (await this.call("GET", "/v1/me")).json()) as Me;
  }

  async list(prefix = ""): Promise<FileInfo[]> {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    return ((await (await this.call("GET", "/v1/files" + q)).json()) as { files: FileInfo[] }).files;
  }

  async read(path: string): Promise<{ text: string | null; base64: string | null; etag: string | null; size: number }> {
    const res = await this.call("GET", "/v1/files/" + KeephavenMemory.encodePath(path));
    const buf = Buffer.from(await res.arrayBuffer());
    const etag = res.headers.get("etag");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return { text, base64: null, etag, size: buf.length };
    } catch {
      return { text: null, base64: buf.toString("base64"), etag, size: buf.length };
    }
  }

  async write(path: string, content: string | Uint8Array, ifMatch?: string): Promise<{ path: string; size: number; etag: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (ifMatch) headers["If-Match"] = ifMatch;
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const res = await this.call("PUT", "/v1/files/" + KeephavenMemory.encodePath(path), body, headers);
    return (await res.json()) as { path: string; size: number; etag: string };
  }

  async remove(path: string): Promise<void> {
    await this.call("DELETE", "/v1/files/" + KeephavenMemory.encodePath(path));
  }

  async journalAppend(entry: Record<string, unknown>): Promise<{ seq: number; file: string }> {
    const res = await this.call("POST", "/v1/journal", JSON.stringify(entry), { "Content-Type": "application/json" });
    return (await res.json()) as { seq: number; file: string };
  }

  async journalRead(since = "", limit = 50): Promise<JournalEntry[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (since) q.set("since", since);
    return ((await (await this.call("GET", "/v1/journal?" + q.toString())).json()) as { entries: JournalEntry[] }).entries;
  }

  async search(q: string, limit = 20): Promise<SearchHit[]> {
    const p = new URLSearchParams({ q, limit: String(limit) });
    return ((await (await this.call("GET", "/v1/search?" + p.toString())).json()) as { hits: SearchHit[] }).hits;
  }
}
