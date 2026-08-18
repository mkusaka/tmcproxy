import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const proxyJs = join(here, "..", "src", "tmcproxy.ts");
const mockJs = join(here, "fixtures", "mock-downstream.ts");

interface ProxyHandle {
  child: ChildProcess;
  allLines: string[];
  stderrLines: string[];
  sendRaw: (s: string) => void;
  send: (obj: unknown) => void;
  nextResponse: (id: unknown, timeoutMs?: number) => Promise<any>;
  close: () => void;
}

// Start a proxy pointed at the mock downstream. Returns a handle with:
//   send(obj), sendRaw(str), nextResponse(id, timeoutMs), allLines, stderrLines, close().
// allLines accumulates every line emitted on the proxy stdout (for id:null /
// leak checks). nextResponse resolves the next response with the given id.
function startProxy(downstreamArgv: string[]): ProxyHandle {
  const child = spawn(process.execPath, [proxyJs, "--", ...downstreamArgv], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const allLines: string[] = [];
  const stderrLines: string[] = [];
  const pending = new Map<string, { resolve: (v: any) => void }>(); // key(JSON id) -> {resolve}

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line: string) => {
    allLines.push(line);
    try {
      const obj = JSON.parse(line);
      if (obj && "id" in obj && obj.id !== undefined && obj.id !== null) {
        const key = JSON.stringify(obj.id);
        if (pending.has(key)) {
          const p = pending.get(key)!;
          pending.delete(key);
          p.resolve(obj);
        }
      }
    } catch {
      // not a JSON response line
    }
  });
  readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line: string) => {
    stderrLines.push(line);
  });

  return {
    child,
    allLines,
    stderrLines,
    sendRaw(s: string) {
      child.stdin!.write(s.endsWith("\n") ? s : s + "\n");
    },
    send(obj: unknown) {
      this.sendRaw(JSON.stringify(obj));
    },
    nextResponse(id: unknown, timeoutMs = 5000): Promise<any> {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(id);
        pending.set(key, { resolve });
        setTimeout(() => {
          if (pending.has(key)) {
            pending.delete(key);
            reject(new Error(`timeout waiting for id=${id}`));
          }
        }, timeoutMs);
      });
    },
    close() {
      try {
        child.stdin!.end();
      } catch {
        // ignore
      }
    },
  };
}

const DISCOVER = {
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

// Find the first already-arrived stdout line matching a predicate (parsed).
function findLine(allLines: string[], pred: (o: any) => boolean): any | null {
  for (const l of allLines) {
    try {
      const o = JSON.parse(l);
      if (pred(o)) return o;
    } catch {
      // skip
    }
  }
  return null;
}
// Wait until a stdout line matching pred arrives (polls allLines).
async function awaitLine(p: ProxyHandle, pred: (o: any) => boolean, timeoutMs = 4000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = findLine(p.allLines, pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout awaiting line; got: " + JSON.stringify(p.allLines));
}

test("server/discover returns a spec-shaped DiscoverResult", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send(DISCOVER);
    const resp = await p.nextResponse(1);
    assert.equal(resp.jsonrpc, "2.0");
    assert.equal(resp.id, 1);
    const r = resp.result;
    assert.equal(r.resultType, "complete");
    assert.deepEqual(r.supportedVersions, ["2026-07-28", "2025-06-18"]);
    assert.equal(typeof r.capabilities, "object");
    assert.deepEqual(r._meta["io.modelcontextprotocol/serverInfo"], { name: "tmcproxy", version: "0.1.0" });
  } finally {
    p.close();
  }
});

test("discover capabilities come from a real tools/list probe (tools present)", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send(DISCOVER);
    const resp = await p.nextResponse(1);
    assert.deepEqual(resp.result.capabilities, { tools: {} });
  } finally {
    p.close();
  }
});

test("initialize is forwarded transparently (downstream identity preserved)", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const resp = await p.nextResponse(10);
    assert.equal(resp.result.serverInfo.name, "mock");
    assert.equal(resp.result.protocolVersion, "2025-06-18");
  } finally {
    p.close();
  }
});

test("initialize succeeds after discover (proxy must NOT call initialize itself)", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send(DISCOVER);
    await p.nextResponse(1);
    p.send({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const resp = await p.nextResponse(11);
    assert.equal(resp.error, undefined);
    assert.equal(resp.result.serverInfo.name, "mock");
  } finally {
    p.close();
  }
});

test("tools/list forwarded with id preserved", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
    const resp = await p.nextResponse(20);
    const names = resp.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("echo"));
  } finally {
    p.close();
  }
});

test("tools/call preserves id, arguments, and response", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } });
    const resp = await p.nextResponse(21);
    assert.equal(resp.id, 21);
    assert.equal(resp.result.content[0].text, "echo:hello");
  } finally {
    p.close();
  }
});

test("ping forwarded", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 22, method: "ping", params: {} });
    const resp = await p.nextResponse(22);
    assert.deepEqual(resp.result, {});
  } finally {
    p.close();
  }
});

test("unknown method is forwarded and downstream error flows back with id preserved", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 23, method: "foo/bar", params: {} });
    const resp = await p.nextResponse(23);
    assert.equal(resp.error.code, -32601);
    assert.match(resp.error.message, /foo\/bar/);
  } finally {
    p.close();
  }
});

test("malformed JSON yields -32700 with id null and is not forwarded", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.sendRaw("{not json");
    const err = await awaitLine(p, (o) => o.error && o.error.code === -32700 && o.id === null);
    assert.equal(err.error.code, -32700);
    // no other line should have leaked (the mock would not have answered)
    assert.equal(p.allLines.length, 1);
  } finally {
    p.close();
  }
});

test("notifications (no id) are forwarded and elicit no response", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    p.send({ jsonrpc: "2.0", id: 30, method: "ping", params: {} });
    const resp = await p.nextResponse(30);
    assert.deepEqual(resp.result, {});
    // The only stdout line so far must be the ping response — the notification
    // produced nothing.
    assert.equal(p.allLines.length, 1);
  } finally {
    p.close();
  }
});

test("downstream stderr is mirrored to proxy stderr prefixed", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "write_stderr", arguments: { line: "hello-stderr" } } });
    await p.nextResponse(40);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      p.stderrLines.some((l) => l.includes("downstream stderr:") && l.includes("MOCK_STDERR_LINE:hello-stderr")),
      "stderr not mirrored: " + JSON.stringify(p.stderrLines)
    );
  } finally {
    p.close();
  }
});

test("after downstream exits, subsequent requests get -32000 downstream closed", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "crash", arguments: {} } });
    const bye = await p.nextResponse(50);
    assert.equal(bye.result.content[0].text, "bye");
    await new Promise((r) => setTimeout(r, 500)); // let the proxy observe the exit
    p.send({ jsonrpc: "2.0", id: 51, method: "ping", params: {} });
    const resp = await p.nextResponse(51);
    assert.equal(resp.error.code, -32000);
    assert.match(resp.error.message, /downstream closed/);
  } finally {
    p.close();
  }
});

test("diagnostics never appear on stdout (only stderr)", async () => {
  const p = startProxy([process.execPath, mockJs]);
  try {
    p.send({ jsonrpc: "2.0", id: 60, method: "ping", params: {} });
    await p.nextResponse(60);
    await new Promise((r) => setTimeout(r, 200));
    for (const l of p.allLines) {
      assert.doesNotMatch(l, /\[tmcproxy\]/, "diagnostic leaked to stdout: " + l);
    }
  } finally {
    p.close();
  }
});
