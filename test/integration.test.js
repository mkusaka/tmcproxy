import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { access, constants } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const proxyJs = join(here, "..", "src", "tmcproxy.ts");

// Resolve a binary on PATH without spawning a shell (avoids DEP0190).
async function have(bin) {
  const paths = (process.env.PATH ?? "").split(":");
  for (const dir of paths) {
    if (!dir) continue;
    const abs = join(dir, bin);
    try {
      await access(abs, constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

function runSession(downstreamArgv, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [proxyJs, "--", ...downstreamArgv], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map();
    const stderrLines = [];
    let stdoutBuf = "";
    const done = new Set();
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const o = JSON.parse(line);
        if (o && "id" in o) responses.set(o.id, o);
        if (o && o.id !== undefined && o.id !== null) done.add(JSON.stringify(o.id));
      } catch {
        // ignore
      }
    });
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (l) => stderrLines.push(l));
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("timeout; stderr=" + JSON.stringify(stderrLines)));
    }, 30000);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    // resolve when every request id has a response
    const wait = setInterval(() => {
      const all = requests.every((r) => r.id === undefined || done.has(JSON.stringify(r.id)));
      if (all) {
        clearInterval(wait);
        clearTimeout(timeout);
        try { child.stdin.end(); } catch {}
        resolve({ responses, stderrLines });
      }
    }, 50);
  });
}

const DISCOVER = {
  jsonrpc: "2.0",
  id: "d",
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "integration", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

async function runAgainst(downstreamArgv) {
  const { responses } = await runSession(downstreamArgv, [
    DISCOVER,
    { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "1.0.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "t", method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: "p", method: "ping", params: {} },
  ]);
  const d = responses.get("d");
  const i = responses.get("i");
  const t = responses.get("t");
  const p = responses.get("p");
  assert.ok(d.result, "discover failed: " + JSON.stringify(d));
  assert.equal(d.result.resultType, "complete");
  assert.deepEqual(d.result.supportedVersions, ["2026-07-28", "2025-06-18"]);
  assert.ok(d.result.capabilities.tools !== undefined, "discover should advertise tools capability");
  assert.ok(i.result, "initialize failed: " + JSON.stringify(i));
  assert.ok(i.result.protocolVersion, "initialize missing protocolVersion");
  assert.ok(Array.isArray(t.result.tools) && t.result.tools.length > 0, "tools/list empty");
  assert.deepEqual(p.result, {});
  return { d, i, t, p };
}

test("codex mcp-server through proxy: discover + initialize + tools/list + ping", { skip: !(await have("codex")) ? "codex not installed" : false }, async () => {
  await runAgainst(["codex", "mcp-server"]);
});

test("local-mcp mcp through proxy: discover + initialize + tools/list + ping", { skip: !(await have("local-mcp")) ? "local-mcp not installed" : false }, async () => {
  await runAgainst(["local-mcp", "mcp"]);
});
