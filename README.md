# keephaven-mcp

Your agent's memory, on a box in your house. An MCP server that gives an AI agent a long-term memory stored on a [Keephaven](https://github.com/dafarusd/keephaven), not on a vendor's server.

Works with MCP clients that run local servers, like Claude Desktop, Claude Code and Cursor.

## What the agent gets

| Tool | What it does |
|---|---|
| `memory_write` | Save a file, like `people/dafarus.md` or `projects/keephaven.md`. Optional etag check so two sessions don't overwrite each other. |
| `memory_read` | Read a file back, with its etag. |
| `memory_list` | List files, optionally under a folder. |
| `memory_search` | Case-insensitive search across files and journal. |
| `memory_delete` | Delete a file. |
| `journal_append` | Add an entry to an append-only journal. The agent can add to it, never edit or delete it. |
| `journal_read` | Read recent journal entries, oldest first. |
| `memory_status` | Name, read-only or not, quota used. |

## What the owner keeps

- Each agent gets its own folder and can't see any other agent's.
- You add an agent in Keephaven's **Settings > Agents** and get a token, shown once. The box stores only a fingerprint of it.
- Revoke cuts the agent off at once. Its files stay until you delete them.
- Set a size limit per agent, or make one read-only.
- If your Keephaven backs up to a second box, the agent's folder is part of that backup, and the backup box refuses every delete. That part isn't tested between two real boxes yet.

## Set it up

1. On the Keephaven: **Settings > Agents > Add an agent**. Copy the two values it shows.
2. Add the server to your MCP client. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keephaven": {
      "command": "npx",
      "args": ["-y", "github:dafarusd/keephaven-mcp"],
      "env": {
        "KEEPHAVEN_URL": "http://keephaven-xxxx.local:8790",
        "KEEPHAVEN_TOKEN": "khm_..."
      }
    }
  }
}
```

For Claude Code:

```
claude mcp add keephaven -e KEEPHAVEN_URL=http://keephaven-xxxx.local:8790 -e KEEPHAVEN_TOKEN=khm_... -- npx -y github:dafarusd/keephaven-mcp
```

It installs straight from GitHub, so the first start takes a minute while it builds. Needs Node 20 or newer.

The machine running the agent has to reach the box: same home network, the Keephaven's own Wi-Fi, or your Tailscale tailnet when Remote access is on.

## Try it with no box

The box runs one Python file with no dependencies. Run that same file anywhere with Python 3:

```
python3 agent-memory.py serve --data ./mem --bind 127.0.0.1 --dev-token khm_try-it-locally
```

Then point the MCP server at `http://127.0.0.1:8790` with that token. The file is `modules/agent-memory.py` in the Keephaven repo.

## Status, honestly

- The memory service is built and tested: 20 API tests, and a two-VM NixOS test where the service runs as its own locked-down user and a second machine uses it over the network.
- This MCP server has 7 end-to-end tests: the official MCP client, this server over stdio, and the real memory service.
- It's run on one Raspberry Pi 5 test box, from a dev image: adding an agent, its token, a file and a journal entry surviving a reboot, and revoking all worked. Backing the folder up to a second box is **not** tested yet. It's not in a Keephaven release image, and it's switched off in every shipped image.
- Tokens travel in plain HTTP on your home network, like the rest of the box's local pages. Over Tailscale they're encrypted.



## Agent skill

`skill/keephaven/` is an agent skill (a `SKILL.md` plus a read-only `check.py`): how to use a Keephaven as memory, and how to boot one in a VM and report what works. `check.py` was run against the Photos SSD image booted in QEMU: setup page, then ready, Photos up, Immich 3.0.3.

Built by [@Dafarusd](https://x.com/Dafarusd). MIT License.
