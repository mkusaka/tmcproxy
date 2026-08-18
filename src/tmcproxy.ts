#!/usr/bin/env node
// tmcproxy: minimal MCP stdio compatibility proxy.
//
// Sits between an OpenAI Secure MCP Tunnel / ChatGPT connector (upstream) and a
// legacy stdio MCP server (downstream) that does not implement `server/discover`
// (e.g. `codex mcp-server`, `local-mcp mcp`). It:
//   - answers `server/discover` on the downstream's behalf, with a spec-shaped
//     DiscoverResult (MCP 2026-07-28 / draft). Capabilities are probed from the
//     downstream via `tools/list` (empirical, not guessed); the supported
//     protocol version and server identity are the proxy's own bridge
//     declaration;
//   - forwards every other request/notification to the downstream verbatim with
//     its JSON-RPC id preserved, and streams responses back upstream. In
//     particular `initialize` is forwarded untouched — we never call
//     `initialize` on the downstream ourselves, because `codex mcp-server`
//     allows initialize exactly once and the client's handshake must be the one
//     that reaches it;
//   - mirrors downstream stderr to stderr (prefixed) for diagnostics;
//   - never writes diagnostics to stdout (the MCP channel).
//
// JSON-RPC framing is handled at the line level on purpose: the MCP SDK would
// drop the unknown `server/discover` method, so we stay below it.
//
// server/discover response FORM is taken from the MCP spec
// (https://modelcontextprotocol.io/specification/draft/server/discover) and
// confirmed against OpenAI Agents SDK docs / tunnel-client issue #40 — not
// guessed.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

const PROXY_NAME = "tmcproxy";
const PROXY_VERSION = "0.1.0";
// Advertise both modern (2026-07-28) and legacy (2025-06-18). A successful
// server/discover response that includes 2026-07-28 tells ChatGPT to stay in
// modern mode — it then sends tools/list etc. directly (no initialize
// handshake, which 2026-07-28 retired). Those stateless requests are forwarded
// to the legacy downstream, which answers them fine (confirmed for codex
// mcp-server and local-mcp mcp: both answer tools/list without initialize).
// Listing 2025-06-18 too signals dual-era support as a fallback.
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-06-18"];
// The capability probe assumes the downstream answers `tools/list` without a
// prior `initialize`. True for codex mcp-server and local-mcp mcp (confirmed
// empirically). If a future downstream requires initialize first, the probe
// fails soft to {} capabilities and the client still proceeds.
const PROBE_TIMEOUT_MS = 8000;
const DEBUG = process.env.TMCPROXY_DEBUG === "1";

type Json = unknown;

function log(msg: string): void {
  // Diagnostics go to stderr only. Never stdout (that is the MCP channel).
  process.stderr.write(`[${PROXY_NAME}] ${msg}\n`);
}

function parseDownstreamArgv(): string[] {
  const dashDash = process.argv.indexOf("--");
  if (dashDash !== -1) {
    const rest = process.argv.slice(dashDash + 1);
    if (rest.length > 0) return rest;
  }
  const env = process.env.TMCPROXY_DOWNSTREAM;
  if (env && env.trim()) {
    // Whitespace split is fine here — the supported downstream commands
    // (`codex mcp-server`, `local-mcp mcp`) have no args with spaces. Add a
    // real argv parser if a downstream ever needs quoted args.
    return env.trim().split(/\s+/);
  }
  log(
    "no downstream command: pass `-- <cmd> <args...>` or set TMCPROXY_DOWNSTREAM=\"<cmd> <args...>\""
  );
  process.exit(2);
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function jsonrpcError(id: Json, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  writeJson({ jsonrpc: "2.0", id, error });
}

// Serialize writes to the downstream stdin so a probe and forwarded client
// requests can't interleave mid-line.
class LineWriter {
  private chain: Promise<void> = Promise.resolve();
  private stream: NodeJS.WritableStream;
  constructor(stream: NodeJS.WritableStream) {
    this.stream = stream;
  }
  write(line: string): Promise<void> {
    this.chain = this.chain.then(() => this.writeOne(line));
    return this.chain;
  }
  end(): Promise<void> {
    this.chain = this.chain.then(() =>
      void (this.stream as NodeJS.WritableStream & { end: () => void }).end()
    );
    return this.chain;
  }
  private writeOne(line: string): Promise<void> {
    return new Promise((resolve) => {
      const ok = this.stream.write(line);
      if (ok) resolve();
      else this.stream.once("drain", () => resolve());
    });
  }
}

interface CapabilitiesProbe {
  capabilities: Record<string, unknown>;
}

class Proxy {
  private child: ChildProcessWithoutNullStreams;
  private downIn: LineWriter;
  private argv: string[];
  private readonly probeId = `${PROXY_NAME}:probe:toolslist:${randomUUID()}`;
  private probeResolve: ((v: CapabilitiesProbe) => void) | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probePromise: Promise<CapabilitiesProbe> | null = null;
  private downstreamClosed = false;
  private shutdownStarted = false;

  constructor(argv: string[]) {
    this.argv = argv;
    const c = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    this.child = c as ChildProcessWithoutNullStreams;
    this.downIn = new LineWriter(this.child.stdin);
  }

  start(): void {
    log(`downstream: ${JSON.stringify(this.argv)}`);

    readline.createInterface({ input: this.child.stderr, crlfDelay: Infinity }).on(
      "line",
      (line) => log(`downstream stderr: ${line}`)
    );

    // downstream stdout -> single router: consume probe response, forward the rest.
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on(
      "line",
      (line) => this.onDownstreamLine(line)
    );

    this.child.on("exit", (code, signal) => {
      this.downstreamClosed = true;
      log(`downstream exited code=${code} signal=${signal}`);
      if (this.probeResolve) {
        this.probeResolve({ capabilities: {} });
        this.probeResolve = null;
      }
      // Stay alive while the upstream stdin is still open so subsequent requests
      // get a clear -32000 "downstream closed" instead of a broken pipe. The
      // proxy exits when the upstream disconnects (shutdown) or on a signal.
      if (this.shutdownStarted) this.exit(code ?? (signal ? 130 : 1));
    });
    this.child.on("error", (err) => {
      log(`downstream spawn error: ${err.message}`);
      this.exit(1);
    });

    const inRl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    inRl.on("line", (line) => void this.onUpstreamLine(line));
    inRl.on("close", () => this.shutdown());

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        log(`received ${sig}, forwarding to downstream`);
        try {
          this.child.kill(sig);
        } catch {
          // ignore
        }
        this.exit(130);
      });
    }
  }

  private async onUpstreamLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;

    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch (e) {
      // Don't echo the raw line — it may contain caller data.
      const prefix = line.slice(0, 80);
      log(`parse error: ${(e as Error).message} (line prefix: ${JSON.stringify(prefix)})`);
      jsonrpcError(null, -32700, "Parse error");
      return;
    }

    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      const id = (msg as { id?: Json } | null)?.id ?? null;
      if (id !== null && id !== undefined) jsonrpcError(id, -32600, "Invalid Request");
      return;
    }

    const obj = msg as Record<string, unknown>;
    const method = typeof obj.method === "string" ? obj.method : "";
    const id = (obj.id as Json) ?? null;
    const hasId = "id" in obj && obj.id !== undefined;

    if (method === "server/discover") {
      if (!hasId) return; // notification with no id: nothing to reply to.
      if (DEBUG) log(`discover request: ${line}`);
      try {
        const result = await this.handleDiscover();
        writeJson({ jsonrpc: "2.0", id, result });
      } catch (e) {
        log(`server/discover failed: ${(e as Error).message}`);
        jsonrpcError(id, -32000, `server/discover failed: ${(e as Error).message}`);
      }
      return;
    }

    // Everything else (initialize, tools/list, tools/call, ping, notifications,
    // ...) is forwarded verbatim. If downstream is gone, surface an error for
    // requests (notifications are silently dropped, per JSON-RPC).
    if (this.downstreamClosed) {
      if (hasId) jsonrpcError(id, -32000, "downstream closed");
      return;
    }
    await this.downIn.write(line + "\n");
  }

  private onDownstreamLine(line: string): void {
    // Route: is this our probe response? Match by id without a full parse first.
    if (this.probeResolve && line.includes(`"${this.probeId}"`)) {
      let resp: Record<string, unknown>;
      try {
        resp = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not parseable; wait for the real probe line
      }
      if (resp.id !== this.probeId) return;
      if (this.probeTimer) {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
      }
      const resolve = this.probeResolve;
      this.probeResolve = null;
      const result = (resp.result ?? {}) as Record<string, unknown>;
      const tools = Array.isArray(result.tools) ? result.tools : null;
      // Empirical capability: tools/list returned a tools array -> tools cap.
      const capabilities: Record<string, unknown> = tools ? { tools: {} } : {};
      resolve?.({ capabilities });
      return;
    }
    // Forward verbatim upstream.
    process.stdout.write(line + "\n");
  }

  // Lazily probe the downstream with `tools/list` once; reuse for later discovers.
  private probeCapabilities(): Promise<CapabilitiesProbe> {
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.runProbe();
    return this.probePromise;
  }

  private runProbe(): Promise<CapabilitiesProbe> {
    return new Promise<CapabilitiesProbe>((resolve) => {
      if (this.downstreamClosed) {
        resolve({ capabilities: {} });
        return;
      }
      this.probeResolve = resolve;
      this.probeTimer = setTimeout(() => {
        if (!this.probeResolve) return;
        this.probeResolve = null;
        resolve({ capabilities: {} });
      }, PROBE_TIMEOUT_MS);

      const req = {
        jsonrpc: "2.0",
        id: this.probeId,
        method: "tools/list",
        params: {},
      };
      void this.downIn.write(JSON.stringify(req) + "\n");
    });
  }

  private async handleDiscover(): Promise<Record<string, unknown>> {
    const { capabilities } = await this.probeCapabilities();
    const result: Record<string, unknown> = {
      resultType: "complete",
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities,
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: PROXY_NAME,
          version: PROXY_VERSION,
        },
      },
      ttlMs: 3600000,
      cacheScope: "public",
    };
    if (DEBUG) log(`discover response: ${JSON.stringify(result)}`);
    return result;
  }

  private shutdown(): void {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    // Close downstream stdin so it can flush and exit; give it a moment.
    this.downIn.end().catch(() => undefined);
    setTimeout(() => this.exit(0), 3000).unref();
  }

  private exit(code: number): void {
    try {
      if (!this.downstreamClosed) this.child.kill("SIGKILL");
    } catch {
      // ignore
    }
    process.exit(code);
  }
}

function main(): void {
  const argv = parseDownstreamArgv();
  const proxy = new Proxy(argv);
  proxy.start();
}

main();
