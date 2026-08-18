# tmcproxy

Minimal MCP stdio compatibility proxy that bridges OpenAI Secure MCP Tunnel / ChatGPT connectors to legacy stdio MCP servers.

## The problem this solves

ChatGPT connectors (via OpenAI Secure MCP Tunnel) probe stdio MCP servers with `server/discover` — a method introduced in MCP `2026-07-28`. Legacy servers like `codex mcp-server` and `local-mcp mcp` only speak `2025-06-18` and return `method not found` for `server/discover`, causing connector creation to fail.

tmcproxy sits in between, answers `server/discover` on the downstream's behalf, and forwards every other request verbatim.

```
ChatGPT → tunnel-client → tmcproxy → codex mcp-server (or local-mcp mcp)
                                ↑
                   answers server/discover here,
                   forwards everything else straight through
```

## Requirements

- Node.js >= 23.6.0 (for native TypeScript strip-mode execution — no build step needed)

## Usage

### Standalone

```bash
node src/tmcproxy.ts -- codex mcp-server
node src/tmcproxy.ts -- local-mcp mcp
```

Or via environment variable:

```bash
TMCPROXY_DOWNSTREAM="codex mcp-server" node src/tmcproxy.ts
```

### With tunnel-client

Edit your tunnel-client profile YAML (e.g. `~/.config/tunnel-client/<profile>.yaml`):

```yaml
mcp:
  commands:
    - channel: main
      command: "node /path/to/tmcproxy/src/tmcproxy.ts -- codex mcp-server"
```

Then:

```bash
tunnel-client run --profile <profile>
```

Switching downstreams is just changing the command after `--`:

```yaml
      command: "node /path/to/tmcproxy/src/tmcproxy.ts -- local-mcp mcp"
```

## How it works

| Request | Behavior |
|---------|----------|
| `server/discover` | Proxy answers with a spec-shaped `DiscoverResult`. Capabilities are probed from the downstream via `tools/list` (not guessed). |
| `initialize` | Forwarded verbatim to downstream. The proxy never calls `initialize` itself — `codex mcp-server` allows it exactly once, so the client's handshake must be the one that reaches it. |
| `tools/list`, `tools/call`, `ping`, etc. | Forwarded verbatim with JSON-RPC id preserved. |
| Notifications (no id) | Forwarded; no response expected. |
| Malformed JSON | `-32700 Parse error` returned to upstream, not forwarded. |
| Unknown method | Forwarded; downstream error flows back. |

### Why `supportedVersions` includes `2026-07-28`

ChatGPT probes with `2026-07-28`. If the response only lists `2025-06-18`, ChatGPT treats it as "requested version not supported" and retries indefinitely — never reaching `initialize` or `tools/list`. By listing `2026-07-28`, ChatGPT enters modern mode and sends stateless requests (`tools/list`, `tools/call`) directly. The legacy downstream answers these without a prior `initialize` (confirmed for both `codex mcp-server` and `local-mcp mcp`), so transparent forwarding works.

## Debugging

### Debug log

Set `TMCPROXY_DEBUG=1` to log `server/discover` requests and responses to stderr:

```bash
TMCPROXY_DEBUG=1 tunnel-client run --profile local-codex
```

Output on stderr (stdout stays clean — it's the MCP channel):

```
[tmcproxy] downstream: ["codex","mcp-server"]
[tmcproxy] discover request: {"jsonrpc":"2.0","id":"openai-mcp-discover",...}
[tmcproxy] discover response: {"resultType":"complete","supportedVersions":["2026-07-28","2025-06-18"],...}
```

### Local end-to-end test (no API key needed)

`tunnel-client dev proxy` runs a local in-memory control plane that reproduces the same MCP probe flow ChatGPT uses:

```bash
tunnel-client dev proxy \
  --mcp-command "command=node /path/to/tmcproxy/src/tmcproxy.ts -- codex mcp-server,channel=main" \
  --url-file /tmp/url.json \
  --duration 30s

MCP_URL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/url.json','utf8')).mcp_url)")
curl -sS -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
```

### Baseline comparison

To confirm the proxy is needed, run the downstream directly through `dev proxy` and observe the `server/discover` failure:

```bash
tunnel-client dev proxy \
  --mcp-command "command=codex mcp-server,channel=main" \
  --url-file /tmp/url.json --duration 30s
# server/discover → -32601 method not found
```

## Tests

```bash
pnpm install
pnpm test          # unit + integration
pnpm test:unit     # mock downstream only
pnpm test:integration  # real codex / local-mcp (auto-skipped if not installed)
pnpm typecheck
```

Unit tests use a mock downstream (`test/fixtures/mock-downstream.js`) and cover: discover response shape, capability probing, initialize forwarding, tools/list, tools/call id preservation, ping, unknown methods, malformed JSON, notifications, stderr mirroring, downstream exit handling, and stdout leak detection.

Integration tests spawn the real `codex mcp-server` and `local-mcp mcp` binaries if available on PATH.

## Security

- Diagnostics go to stderr only; stdout is reserved for MCP traffic.
- No credentials, API keys, or secrets are logged.
- Downstream is spawned via argv (no shell).
- Only `server/discover` is handled by the proxy; all other requests pass through unchanged.
- The proxy does not expand the downstream's permissions.

## License

Apache-2.0
