import assert from "node:assert/strict";
import type { Snapshot } from "../src/bridge/register.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function transcriptSnapshot(changes: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    sessionId: "s",
    itemKind: "message",
    itemSemanticKey: "message:1",
    transcriptRevision: "r1",
    layoutRevision: "w80",
    renderedLines: [],
    renderedStartRow: 0,
    visualCursor: { row: 0, col: 0 },
    ...changes,
  };
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
