import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import * as rpc from "vscode-jsonrpc/node.js";
import { URI } from "vscode-uri";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

type ServerSpec = { cmd: string; args: string[]; rootUri: string };

function localBin(name: string): string {
  // dist/ -> …/packages/cli/dist
  const here = dirname(fileURLToPath(import.meta.url));
  // …/packages/cli/node_modules/.bin
  const binDir = join(here, "..", "node_modules", ".bin");
  const exe = process.platform === "win32" ? `${name}.cmd` : name;
  const full = join(binDir, exe);
  return existsSync(full) ? full : name; // fall back to PATH if not found
}

function spawnServer(cmd: string, args: string[]): ChildProcessWithoutNullStreams {
  const opts: SpawnOptions = {
    stdio: "pipe",
    shell: process.platform === "win32", // allow .cmd on Windows
  };
  return spawn(cmd, args, opts) as ChildProcessWithoutNullStreams;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private conn: rpc.MessageConnection;
  private initialized = false;
  private closing = false;

  constructor(spec: ServerSpec) {
    this.proc = spawnServer(spec.cmd, spec.args);

    const reader = new rpc.StreamMessageReader(this.proc.stdout);
    const writer = new rpc.StreamMessageWriter(this.proc.stdin);
    this.conn = rpc.createMessageConnection(reader, writer);

    // Avoid noisy errors during teardown
    this.conn.onError(() => { /* ignore */ });
    this.conn.onClose(() => { /* ignore */ });

    this.conn.listen();

    const params = {
      processId: process.pid,
      rootUri: spec.rootUri,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
        },
        workspace: {
          configuration: true,
        },
      },
    } as any;

    this.conn.sendRequest("initialize", params).then(() => {
      this.initialized = true;
      // Some servers expect an explicit initialized notification to enable features like documentSymbol
      try { this.conn.sendNotification('initialized', {} as any); } catch { /* ignore */ }
      // Optionally announce simple configuration to unlock extra capabilities (best-effort)
      try { this.conn.sendNotification('workspace/didChangeConfiguration', { settings: {} } as any); } catch { /* ignore */ }
    }).catch(() => { /* ignore init errors */ });

    // If the child exits early, prevent any subsequent writes
    this.proc.on("exit", () => { this.closing = true; });
    this.proc.on("error", () => { /* ignore */ });
  }

  async ready(): Promise<void> {
    const start = Date.now();
    while (!this.initialized) {
      await new Promise((r) => setTimeout(r, 50));
      if (Date.now() - start > 10000) throw new Error("LSP init timeout");
    }
  }

  async didOpen(path: string, languageId: string, text: string): Promise<void> {
    if (this.closing) return;
    const doc = { uri: URI.file(path).toString(), languageId, version: 1, text };
    // string method name is safest across protocol lib versions
    await this.conn.sendNotification("textDocument/didOpen", { textDocument: doc });
  }

  // Request full document symbols (hierarchical) via LSP.
  async documentSymbols(path: string): Promise<any[] | undefined> {
    if (this.closing) return undefined;
    const params = { textDocument: { uri: URI.file(path).toString() } };
    try { 
      const res = await this.conn.sendRequest("textDocument/documentSymbol", params);
      if ((process.env.CRV_DEBUG||'').includes('sym')) {
        console.error(`[sym] documentSymbols(${path}) -> ${Array.isArray(res)?res.length:'n/a'}`);
        if ((process.env.CRV_DEBUG||'').includes('symraw') && Array.isArray(res) && res.length) {
          try { console.error('[symraw:first]', JSON.stringify(res[0]).slice(0,500)); } catch {}
        }
      }
      return res as any[]; 
    } catch (e) { 
      if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] documentSymbols(${path}) error: ${(e as Error).message}`);
      return undefined; 
    }
  }

  async prepareCallHierarchy(path: string, position:{line:number; character:number}): Promise<any[] | undefined> {
    if (this.closing) return undefined;
    const params = { textDocument: { uri: URI.file(path).toString() }, position };
    try { return await this.conn.sendRequest("textDocument/prepareCallHierarchy", params); } catch { return undefined; }
  }

  async incomingCalls(item: any): Promise<any[] | undefined> {
    if (this.closing) return undefined;
    try { return await this.conn.sendRequest("callHierarchy/incomingCalls", { item }); } catch { return undefined; }
  }

  async outgoingCalls(item: any): Promise<any[] | undefined> {
    if (this.closing) return undefined;
    try { return await this.conn.sendRequest("callHierarchy/outgoingCalls", { item }); } catch { return undefined; }
  }

  async implementations(path:string, position:{line:number; character:number}): Promise<any[] | undefined> {
    if (this.closing) return undefined;
    const params = { textDocument: { uri: URI.file(path).toString() }, position }; // some servers expect same shape as definition
    try { return await this.conn.sendRequest("textDocument/implementation", params); } catch { return undefined; }
  }

  /** Graceful shutdown: shutdown -> exit -> dispose -> kill (if still alive) */
  async dispose(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    try {
      await this.conn.sendRequest("shutdown").catch(() => {});
      await this.conn.sendNotification("exit");
    } catch { /* ignore */ }

    try { this.conn.dispose(); } catch { /* ignore */ }
    try { this.proc.stdin.end(); } catch { /* ignore */ }

    // Give the server a moment to exit cleanly
    await new Promise((r) => setTimeout(r, 100));

    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

export async function launchTsServer(root: string): Promise<LspClient> {
  const client = new LspClient({
    cmd: localBin("typescript-language-server"),
    args: ["--stdio"],
    rootUri: URI.file(root).toString(),
  });
  await client.ready();
  return client;
}

export async function launchPyright(root: string): Promise<LspClient> {
  const client = new LspClient({
    cmd: localBin("pyright-langserver"),
    args: ["--stdio"],
    rootUri: URI.file(root).toString(),
  });
  await client.ready();
  return client;
}
