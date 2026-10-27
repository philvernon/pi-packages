import net from "node:net";
import { encode, decode } from "./msgpack.ts";
import type { MessagePackValue } from "./msgpack.ts";

export interface NeovimRpc {
  request(method: string, args?: readonly MessagePackValue[]): Promise<unknown>;
}

export interface NeovimRpcConnection extends NeovimRpc {
  close(): void;
}

export interface NeovimConnectionOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export async function connectNeovim(
  socketPath: string | undefined,
  { timeoutMs = 3000 }: NeovimConnectionOptions = {},
): Promise<NeovimRpcConnection> {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) {
    throw new Error("Explicit absolute Neovim socket path required");
  }
  const socket = net.createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Neovim socket connection timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  let buf: Buffer = Buffer.alloc(0);
  let id = 0;
  let closed = false;
  const pending = new Map<number, PendingRequest>();

  function fail(error: unknown): void {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  socket.on("close", () => fail(new Error("Neovim RPC socket closed")));
  socket.on("error", fail);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 10_000_000) {
      fail(new Error("Oversized Neovim RPC frame"));
      socket.destroy();
      return;
    }
    while (buf.length) {
      let part;
      try {
        part = decode(buf);
      } catch (error) {
        if (error instanceof RangeError && /incomplete/u.test(error.message))
          break;
        fail(error);
        socket.destroy();
        return;
      }
      buf = buf.subarray(part.offset);
      const msg = part.value;
      if (!Array.isArray(msg) || msg[0] !== 1 || typeof msg[1] !== "number")
        continue;
      const request = pending.get(msg[1]);
      if (!request) continue;
      pending.delete(msg[1]);
      clearTimeout(request.timer);
      if (msg[2]) {
        request.reject(new Error("Neovim RPC: " + JSON.stringify(msg[2])));
      } else {
        request.resolve(msg[3]);
      }
    }
  });
  return {
    request(method, args = []) {
      if (closed) return Promise.reject(new Error("Neovim socket closed"));
      return new Promise<unknown>((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Neovim RPC timeout"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        socket.write(encode([0, requestId, method, args]), (err) => {
          if (err) {
            pending.delete(requestId);
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    },
    close() {
      fail(new Error("Neovim RPC disconnected"));
      socket.end();
      socket.destroy();
    },
  };
}
