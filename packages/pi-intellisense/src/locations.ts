import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as nodeFs } from "node:fs";
import type { Position } from "./positions.ts";

export type SelectionRange = Record<string, unknown> & { start: Position };

export interface NormalizedLocation {
  uri: string;
  range: unknown;
  selectionRange: SelectionRange;
}

export interface LocationFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

export interface ValidateFileLocationOptions {
  root?: string;
  roots?: readonly string[];
  fs?: LocationFileSystem;
}

export interface ValidatedFileLocation extends Position {
  path: string;
  uri: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPosition(value: unknown): value is Position {
  const start = record(value);
  return (
    start !== undefined &&
    Number.isInteger(start.line) &&
    Number.isInteger(start.character)
  );
}

export function normalizeLocations(response: unknown): NormalizedLocation[] {
  let values: unknown[];
  if (response == null) values = [];
  else if (Array.isArray(response)) values = response;
  else values = [response];
  const seen = new Set<string>();
  const result: NormalizedLocation[] = [];
  for (const value of values) {
    const item = record(value);
    if (!item) continue;
    const uri = item.targetUri ?? item.uri;
    const selectionRange = record(
      item.targetSelectionRange ?? item.range ?? item.targetRange,
    );
    if (
      typeof uri !== "string" ||
      !selectionRange ||
      !isPosition(selectionRange.start)
    )
      continue;
    const key = [
      uri,
      selectionRange.start.line,
      selectionRange.start.character,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      uri,
      range: item.targetRange ?? item.range ?? selectionRange,
      selectionRange: selectionRange as SelectionRange,
    });
  }
  return result;
}

export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
}

export async function validateFileLocation(
  location: unknown,
  options: ValidateFileLocationOptions = {},
): Promise<ValidatedFileLocation> {
  const { root, roots, fs = nodeFs } = options;
  const item = record(location);
  const uri = item?.uri ?? item?.targetUri;
  const start = record(
    item?.selectionRange ?? item?.range ?? item?.targetSelectionRange,
  )?.start;
  if (
    !isPosition(start) ||
    !Number.isSafeInteger(start.line) ||
    start.line < 0 ||
    !Number.isSafeInteger(start.character) ||
    start.character < 0
  ) {
    throw new RangeError("Invalid destination position");
  }
  if (typeof uri !== "string" || !uri.startsWith("file://")) {
    throw new TypeError("Only local file URI scheme allowed");
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new TypeError("Invalid local file URI");
  }
  if (
    url.protocol !== "file:" ||
    (url.hostname && url.hostname !== "localhost")
  ) {
    throw new TypeError("Unsupported URI scheme or host");
  }
  const originalPath = fileURLToPath(url);
  const allowedRoots = roots ?? (root ? [root] : []);
  if (
    !allowedRoots.some((root) =>
      within(path.resolve(root), path.resolve(originalPath)),
    )
  ) {
    throw new Error("Destination outside trusted workspace root");
  }
  const canonical = await fs.realpath(originalPath);
  if (!allowedRoots.some((root) => within(path.resolve(root), canonical))) {
    throw new Error("Destination realpath outside trusted workspace root");
  }
  if (!(await fs.stat(canonical)).isFile()) {
    throw new TypeError("Destination is not a regular file");
  }
  return { path: canonical, uri, line: start.line, character: start.character };
}
