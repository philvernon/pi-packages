import { spawn } from "node:child_process";
import type { LspTransport } from "./lsp/types.ts";
import { isRecord } from "./lsp/normalize.ts";

export interface StdioLspTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
}

type RpcId = number | string;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

export function createStdioLspTransport({
  command,
  args = [],
  cwd,
  timeoutMs = 5000,
  onNotification = () => {},
}: StdioLspTransportOptions): LspTransport {
  if (!command || typeof command !== "string")
    throw new Error("Missing trusted LSP executable");
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let seq = 0;
  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map<RpcId, PendingRequest>();
  const stderr: string[] = [];

  const failure = (message: string): void => {
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(new Error(message));
    }
    pending.clear();
  };
  child.on("error", (err) => failure("LSP failed to launch: " + err.message));
  child.on("exit", (code, signal) =>
    failure(
      "Language server exited (" +
        (signal ?? code) +
        "): " +
        stderr.slice(-4).join(" "),
    ),
  );
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length > 40) stderr.shift();
    stderr.push(
      String(chunk)
        .replace(/[\x00-\x1f\x7f]/gu, " ")
        .slice(0, 500),
    );
  });

  const send = (message: {
    id?: RpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
  }): void => {
    if (closed || !child.stdin.writable)
      throw new Error("Language server is not running");
    const json = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", ...message }),
      "utf8",
    );
    child.stdin.write(
      Buffer.from("Content-Length: " + json.length + "\r\n\r\n", "ascii"),
    );
    child.stdin.write(json);
  };
  const handle = (message: unknown): void => {
    if (
      !isRecord(message) ||
      (message.id !== undefined &&
        typeof message.id !== "string" &&
        typeof message.id !== "number") ||
      (message.method !== undefined && typeof message.method !== "string")
    ) {
      throw new Error("Malformed LSP JSON-RPC message");
    }
    if (message.id !== undefined && message.method) {
      // Respond to common optional server-initiated configuration requests.
      let result: null | null[] = null;
      if (message.method === "workspace/configuration") {
        const items = isRecord(message.params)
          ? message.params.items
          : undefined;
        if (items != null && !Array.isArray(items))
          throw new Error("Malformed LSP configuration request");
        result = (items ?? []).map(() => null);
      }
      send({ id: message.id, result });
      return;
    }
    if (message.id !== undefined) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      p.cleanup();
      if (message.error) {
        const detail =
          isRecord(message.error) && typeof message.error.message === "string"
            ? message.error.message
            : "Malformed JSON-RPC error";
        p.reject(new Error("LSP " + detail));
      } else p.resolve(message.result);
      return;
    }
    if (message.method) onNotification(message.method, message.params);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 16_000_000) {
      failure("LSP frame exceeded size limit");
      child.kill();
      return;
    }
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        failure("Missing LSP Content-Length");
        child.kill();
        return;
      }
      const count = Number(match[1]);
      if (count > 10_000_000) {
        failure("LSP frame too large");
        child.kill();
        return;
      }
      if (buffer.length < headerEnd + 4 + count) break;
      const json = buffer.subarray(headerEnd + 4, headerEnd + 4 + count);
      buffer = buffer.subarray(headerEnd + 4 + count);
      try {
        const message: unknown = JSON.parse(json.toString("utf8"));
        handle(message);
      } catch (err) {
        onNotification("pi-intellisense/protocolError", String(err));
      }
    }
  });

  return {
    request(method, params, { signal, timeoutMs: limit = timeoutMs } = {}) {
      if (signal?.aborted)
        return Promise.reject(new Error("LSP request cancelled"));
      return new Promise<unknown>((resolve, reject) => {
        const id = ++seq;
        let timer: ReturnType<typeof setTimeout>;
        const cancel = (): void => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          try {
            send({ method: "$/cancelRequest", params: { id } });
          } catch {
            // Cancellation is best-effort after the server has stopped.
          }
          reject(new Error("LSP request aborted"));
        };
        if (signal) signal.addEventListener("abort", cancel, { once: true });
        const cleanup = (): void =>
          signal?.removeEventListener("abort", cancel);
        timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          try {
            send({ method: "$/cancelRequest", params: { id } });
          } catch {
            // Cancellation is best-effort after the server has stopped.
          }
          reject(new Error("LSP request timed out"));
        }, limit);
        pending.set(id, { resolve, reject, timer, cleanup });
        try {
          send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          cleanup();
          reject(error);
        }
      });
    },
    async notify(method, params) {
      send({ method, params });
    },
    async close() {
      if (closed) return;
      failure("LSP transport closed");
      child.stdin.end();
      child.kill();
    },
  };
}
