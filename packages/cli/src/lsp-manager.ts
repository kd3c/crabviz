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
  const child = spawn(cmd, args, opts);
  return child as ChildProcessWithoutNullStreams;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private conn: rpc.MessageConnection;
  private initialized = false;

  constructor(spec: ServerSpec) {
    this.proc = spawnServer(spec.cmd, spec.args);
    const reader = new rpc.StreamMessageReader(this.proc.stdout);
    const writer = new rpc.StreamMessageWriter(this.proc.stdin);
    this.conn = rpc.createMessageConnection(reader, writer);
    this.conn.listen();

    const params = { processId: process.pid, rootUri: spec.rootUri, capabilities: {} };
    this.conn.sendRequest("initialize", params).then(() => {
      this.initialized = true;
    });
  }

  async ready(): Promise<void> {
    const start = Date.now();
    while (!this.initialized) {
      await new Promise((r) => setTimeout(r, 50));
      if (Date.now() - start > 10000) throw new Error("LSP init timeout");
    }
  }

  async didOpen(path: string, languageId: string, text: string): Promise<void> {
    const doc = { uri: URI.file(path).toString(), languageId, version: 1, text };
    this.conn.sendNotification("textDocument/didOpen", { textDocument: doc });
  }

  dispose(): void {
    try { this.proc.kill(); } catch {}
    try { this.conn.dispose(); } catch {}
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
