#!/usr/bin/env node
// Mock legacy MCP stdio server for tmcproxy tests. Implements initialize /
// tools/list / tools/call / ping, errors on server/discover (so the proxy must
// intercept it), and provides tools to trigger stderr output and a crash.
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const id = req.id ?? null;
  const hasId = "id" in req && req.id !== undefined;
  const method = req.method;
  const params = req.params ?? {};

  switch (method) {
    case "initialize":
      if (!hasId) return;
      out({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mock", version: "0.0.0" },
        },
      });
      break;
    case "notifications/initialized":
      // notification: no response
      break;
    case "ping":
      if (!hasId) return;
      out({ jsonrpc: "2.0", id, result: {} });
      break;
    case "tools/list":
      if (!hasId) return;
      out({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            { name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
            { name: "write_stderr", description: "write a stderr line", inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] } },
            { name: "crash", description: "exit the server", inputSchema: { type: "object", properties: {} } },
          ],
        },
      });
      break;
    case "tools/call": {
      if (!hasId) return;
      const name = params.name;
      if (name === "echo") {
        const text = (params.arguments ?? {}).text ?? "";
        out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo:" + text }] } });
      } else if (name === "write_stderr") {
        process.stderr.write("MOCK_STDERR_LINE:" + ((params.arguments ?? {}).line ?? "") + "\n");
        out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
      } else if (name === "crash") {
        out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "bye" }] } });
        process.exit(0);
      } else {
        out({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool: " + name } });
      }
      break;
    }
    case "server/discover":
      if (!hasId) return;
      // Legacy server: does not implement discover.
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: server/discover" } });
      break;
    default:
      if (!hasId) return;
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
  }
});

rl.on("close", () => {
  process.exit(0);
});
