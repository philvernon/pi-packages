import path from "node:path";
import { promises as nodeFs } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { extractFencedBlocks } from "../blocks.ts";
import { within } from "../locations.ts";
import type { Snapshot } from "../bridge/register.ts";
import {
  mapRenderedRegion,
  mapRenderedFence,
  resolveTranscriptSymbol,
} from "./transcript-source.ts";
import type {
  RenderedRegion,
  SourceAnchor,
  SourceLine,
  WorkspaceSymbolQuery,
} from "./transcript-source.ts";

export type UnmappedReason =
  | "cursor-not-symbol"
  | "invalid-annotation"
  | "ambiguous"
  | "stale-source"
  | "source-unavailable"
  | "source-unknown"
  | "wrapped-unmappable";

export interface UnmappedSource {
  kind: "unmapped";
  reason: UnmappedReason;
}

export type SourceResolution =
  SourceAnchor | WorkspaceSymbolQuery | UnmappedSource;

export interface ProvenanceFileSystem {
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface ResolveTranscriptProvenanceOptions {
  root: string;
  entries?: readonly unknown[];
  fs?: ProvenanceFileSystem;
}

export interface ReadFileReference {
  candidate: string;
  content: string;
  offset: unknown;
  limit: unknown;
  toolCallId: string;
}

interface ReadCall {
  path: string;
  offset?: unknown;
  limit?: unknown;
}

interface VerifiedFileContents {
  uri: string;
  sourceText: string;
  fileHash: string;
}

interface QuoteMatch {
  start: number;
  sourceLine: number;
  sourceCharacterStart: number;
}

interface ReadCandidate extends QuoteMatch {
  kind?: never;
  file: VerifiedFileContents | null;
  valid: boolean | null;
}

type QuotedReadBinding = ReadCandidate & { file: VerifiedFileContents };

const LANGUAGES = new Map([
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["tsx", "typescriptreact"],
  ["js", "javascript"],
  ["javascript", "javascript"],
  ["jsx", "javascriptreact"],
  ["py", "python"],
  ["python", "python"],
  ["rs", "rust"],
  ["rust", "rust"],
  ["go", "go"],
  ["lua", "lua"],
]);
const MAX_BYTES = 2_000_000;
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const unmapped = (reason: UnmappedReason): UnmappedSource => ({
  kind: "unmapped",
  reason,
});
const linesOf = (text: string): string[] =>
  text.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function readFileReferences(
  entries: readonly unknown[] = [],
): ReadFileReference[] {
  const calls = new Map<string, ReadCall>();
  const records: ReadFileReference[] = [];
  for (const value of entries) {
    const entry = record(value);
    const message = record(entry?.message);
    if (entry?.type !== "message" || !message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const parts: unknown[] = message.content;
      for (const value of parts) {
        const part = record(value);
        const args = record(part?.arguments);
        if (
          part?.type === "toolCall" &&
          part.name === "read" &&
          typeof part.id === "string" &&
          typeof args?.path === "string"
        ) {
          calls.set(part.id, {
            path: args.path,
            offset: args.offset,
            limit: args.limit,
          });
        }
      }
    }
    const truncation = record(record(message.details)?.truncation);
    if (
      message.role !== "toolResult" ||
      message.toolName !== "read" ||
      message.isError ||
      truncation?.truncated
    )
      continue;
    if (typeof message.toolCallId !== "string") continue;
    const args = calls.get(message.toolCallId);
    if (!args) continue;
    const parts: unknown[] = Array.isArray(message.content)
      ? message.content
      : [];
    const content =
      typeof message.content === "string"
        ? message.content
        : parts
            .filter((value) => record(value)?.type === "text")
            .map((value) => record(value)?.text)
            .join("\n");
    if (content && content.length <= MAX_BYTES) {
      records.push({
        candidate: args.path,
        content,
        offset: args.offset ?? 1,
        limit: args.limit,
        toolCallId: message.toolCallId,
      });
    }
  }
  return records;
}

function nativeReadPath(candidate: string): string | null {
  let value = candidate.replace(
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu,
    " ",
  );
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return value;
}

async function safeFile(
  root: string,
  candidate: string | null,
  fs: ProvenanceFileSystem,
): Promise<VerifiedFileContents | null> {
  if (typeof candidate !== "string") return null;
  const proposed = path.resolve(root, candidate);
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(proposed),
  ]).catch(() => []);
  if (!realRoot || !realFile || !within(realRoot, realFile)) return null;
  const contents = await fs.readFile(realFile, "utf8").catch(() => null);
  return typeof contents === "string" && contents.length <= MAX_BYTES
    ? {
        uri: pathToFileURL(realFile).href,
        sourceText: contents,
        fileHash: hash(contents),
      }
    : null;
}

function readLines(
  record: ReadFileReference,
  file: VerifiedFileContents,
): SourceLine[] | null {
  const { offset, limit } = record;
  if (!positiveInteger(offset)) return null;
  const disk = linesOf(file.sourceText);
  const rows = linesOf(record.content).map((text, i) => ({
    text,
    sourceLine: offset - 1 + i,
  }));
  if (
    (limit === undefined ||
      (typeof limit === "number" &&
        Number.isSafeInteger(limit) &&
        limit >= rows.length)) &&
    rows.every((row) => disk[row.sourceLine] === row.text)
  )
    return rows;
  if (!positiveInteger(limit)) return null;
  const allLines = file.sourceText.replace(/\r\n/gu, "\n").split("\n");
  const end = offset - 1 + limit;
  const selected = allLines.slice(offset - 1, end).join("\n");
  const remaining = allLines.length - end;
  const expected =
    selected +
    `\n\n[${remaining} more lines in file. Use offset=${end + 1} to continue.]`;
  if (remaining <= 0 || record.content.replace(/\r\n/gu, "\n") !== expected)
    return null;
  return linesOf(selected).map((text, i) => ({
    text,
    sourceLine: offset - 1 + i,
  }));
}

function commonIndent(lines: readonly string[]): string {
  const nonblank = lines.filter((line) => line.trim());
  let prefix = /^[\t ]*/u.exec(nonblank[0] ?? "")![0];
  for (const line of nonblank) {
    while (!line.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function quotedRanges(
  quote: readonly string[],
  rows: SourceLine[],
): QuoteMatch[] {
  const indent = commonIndent(quote);
  const body = quote.map((line) =>
    line.trim() ? line.slice(indent.length) : "",
  );
  const first = body.findIndex((line) => line.trim());
  if (first < 0) return [];
  const matches: QuoteMatch[] = [];
  for (let start = 0; start + quote.length <= rows.length; start++) {
    if (rows[start + first].text.trimStart() !== body[first].trimStart())
      continue;
    const window = rows.slice(start, start + quote.length);
    const prefix = commonIndent(window.map((row) => row.text));
    if (
      window.some(
        (row, i) =>
          (row.text.trim() ? row.text.slice(prefix.length) : "") !== body[i],
      )
    )
      continue;
    matches.push({
      start,
      sourceLine: window[0].sourceLine,
      sourceCharacterStart: prefix.length - indent.length,
    });
    if (matches.length === 2) break;
  }
  return matches;
}

async function quotedReadSource(
  quote: readonly string[],
  {
    root,
    entries,
    fs,
  }: { root: string; entries: readonly unknown[]; fs: ProvenanceFileSystem },
): Promise<QuotedReadBinding | UnmappedSource | null> {
  const candidates = new Map<string, ReadCandidate>();
  const files = new Map<string, Promise<VerifiedFileContents | null>>();
  for (const record of readFileReferences(entries)) {
    const { offset, limit } = record;
    if (
      !positiveInteger(offset) ||
      (limit !== undefined && !positiveInteger(limit))
    )
      continue;
    const rows = linesOf(record.content)
      .slice(0, limit)
      .map((text, i) => ({ text, sourceLine: offset - 1 + i }));
    const matches = quotedRanges(quote, rows);
    if (!matches.length) continue;
    const candidate = nativeReadPath(record.candidate);
    if (candidate === null) continue;
    const proposed = path.resolve(root, candidate);
    if (!files.has(proposed))
      files.set(proposed, safeFile(root, candidate, fs));
    const file = await files.get(proposed)!;
    const verified = file && readLines(record, file);
    for (const match of matches) {
      const key = JSON.stringify([
        file?.uri ?? proposed,
        match.sourceLine,
        match.sourceCharacterStart,
      ]);
      const valid = verified && match.start + quote.length <= verified.length;
      if (!candidates.has(key) || valid)
        candidates.set(key, { ...match, file, valid });
    }
  }
  if (candidates.size > 1) return unmapped("ambiguous");
  const binding = candidates.values().next().value;
  if (!binding) return null;
  if (!binding.valid)
    return unmapped(binding.file ? "stale-source" : "source-unavailable");
  return { ...binding, file: binding.file! };
}

export async function resolveTranscriptProvenance(
  snapshot: Snapshot | null | undefined,
  options: ResolveTranscriptProvenanceOptions,
): Promise<SourceResolution> {
  const { root, entries = [], fs = nodeFs } = options;
  if (!snapshot?.visualCursor) return unmapped("cursor-not-symbol");
  const cursor = snapshot.visualCursor;
  const regions: RenderedRegion[] = [];
  if (snapshot.itemKind === "tool") {
    const records = readFileReferences(entries).filter(
      (record) => record.toolCallId === snapshot.toolCallId,
    );
    if (records.length !== 1)
      return unmapped(records.length ? "ambiguous" : "source-unknown");
    const record = records[0];
    const file = await safeFile(root, nativeReadPath(record.candidate), fs);
    if (!file) return unmapped("source-unknown");
    const lines = readLines(record, file);
    if (!lines) return unmapped("stale-source");
    regions.push(
      ...mapRenderedRegion(snapshot, {
        ...file,
        kind: "verified-file" as const,
        origin: "structured-read" as const,
        lines,
      }),
    );
  } else if (snapshot.itemKind === "message") {
    if (typeof snapshot.sourceText !== "string")
      return unmapped("source-unknown");
    const blocks = extractFencedBlocks(snapshot.sourceText, {
      messageId: snapshot.itemSemanticKey,
      origin: "assistant",
    });
    for (const block of blocks) {
      const codeLines = linesOf(block.code);
      if (!block.code) continue;
      // Map before validating so a broken annotation elsewhere cannot disable this block.
      const placements = mapRenderedFence(snapshot, block, blocks);
      if (
        !placements.some((region) =>
          region.displayLines.some((row) => row.displayRow === cursor.row),
        )
      )
        continue;
      if (block.sourceError) return unmapped(block.sourceError);
      if (block.sourceBinding) {
        const binding = block.sourceBinding;
        const file = await safeFile(root, binding.path, fs);
        if (!file) return unmapped("source-unavailable");
        const disk = linesOf(file.sourceText);
        if (
          binding.endLine - binding.startLine + 1 !== codeLines.length ||
          codeLines.some((line, i) => disk[binding.startLine + i] !== line)
        )
          return unmapped("stale-source");
        regions.push(
          ...placements.map((region) => ({
            ...region,
            ...file,
            kind: "verified-file" as const,
            origin: "annotated-fence" as const,
            displayLines: region.displayLines.map((row) => ({
              ...row,
              sourceLine: row.sourceLine + binding.startLine,
            })),
          })),
        );
      } else {
        const binding = await quotedReadSource(codeLines, {
          root,
          entries,
          fs,
        });
        if (binding && binding.kind !== "unmapped") {
          const sourceRow = <T extends SourceLine>(row: T) => ({
            ...row,
            sourceLine: row.sourceLine + binding.sourceLine,
            sourceCharacterStart: binding.sourceCharacterStart,
          });
          regions.push(
            ...placements.map((region) => ({
              ...region,
              ...binding.file,
              kind: "verified-file" as const,
              origin: "read-quote" as const,
              lines: region.lines.map(sourceRow),
              displayLines: region.displayLines.map(sourceRow),
            })),
          );
        } else {
          const languageId = LANGUAGES.get(block.language.toLowerCase());
          if (!languageId) continue;
          regions.push(
            ...placements.map((region) => ({
              ...region,
              kind: "workspace-symbol-query" as const,
              languageId,
            })),
          );
        }
      }
    }
  } else return unmapped("source-unknown");
  const hits = regions.filter((region) =>
    region.displayLines.some((row) => row.displayRow === cursor.row),
  );
  if (hits.length > 1) return unmapped("ambiguous");
  if (!hits.length) return unmapped("wrapped-unmappable");
  const anchor = resolveTranscriptSymbol({ snapshot, regions: hits });
  return anchor ?? unmapped("cursor-not-symbol");
}
