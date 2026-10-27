import { createHash } from "node:crypto";

export interface SourceBinding {
  path: string;
  startLine: number;
  endLine: number;
}

export interface SourceAnnotation {
  sourceBinding?: SourceBinding;
  sourceError?: "invalid-annotation";
}

export interface FencedBlock extends SourceAnnotation {
  id: string;
  messageId: string;
  origin: string;
  language: string;
  code: string;
  blockIndex: number;
}

export interface ExtractFencedBlocksOptions {
  messageId?: string;
  origin?: string;
}

interface OpenFence extends SourceAnnotation {
  marker: string;
  count: number;
  language: string;
  blockIndex: number;
}

function id(parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 18);
}

export function sourceAnnotation(info: string): SourceAnnotation {
  if (!/(?:^|\s)(?:source|lines)=/u.test(info)) return {};
  const match =
    /^\S+\s+source=("(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[\da-fA-F]{4})*")\s+lines="([1-9]\d*)(?:-([1-9]\d*))?"\s*$/u.exec(
      info.trim(),
    );
  if (!match) return { sourceError: "invalid-annotation" };
  let source: string;
  try {
    source = JSON.parse(match[1]) as string;
  } catch {
    return { sourceError: "invalid-annotation" };
  }
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (
    !source ||
    /[\x00-\x1f]/u.test(source) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start
  ) {
    return { sourceError: "invalid-annotation" };
  }
  return {
    sourceBinding: { path: source, startLine: start - 1, endLine: end - 1 },
  };
}

export function hideSourceAnnotations(markdown: string): string {
  let marker = "";
  let count = 0;
  return markdown.replace(
    /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gmu,
    (line: string, fence: string, info: string) => {
      if (marker) {
        if (fence[0] === marker && fence.length >= count && !info.trim())
          marker = "";
        return line;
      }
      if (fence[0] === "`" && info.includes("`")) return line;
      marker = fence[0];
      count = fence.length;
      return /(?:^|\s)(?:source|lines)=/u.test(info)
        ? line.slice(0, line.length - info.length) + info.trim().split(/\s/u)[0]
        : line;
    },
  );
}

/** Annotations locate candidates; only file-content verification can establish provenance. */
export function extractFencedBlocks(
  markdown: unknown,
  { messageId = "", origin = "assistant" }: ExtractFencedBlocksOptions = {},
): FencedBlock[] {
  if (typeof markdown !== "string" || markdown.length > 250_000) return [];
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const blocks: FencedBlock[] = [];
  let open: OpenFence | null = null;
  let body = "";
  for (const line of lines) {
    const withoutNewline = line.endsWith("\n")
      ? line.slice(0, -1).replace(/\r$/u, "")
      : line;
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(withoutNewline);
      if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
        open = {
          marker: match[1][0],
          count: match[1].length,
          language: match[2].trim().split(/\s+/u)[0] || "",
          blockIndex: blocks.length,
          ...sourceAnnotation(match[2]),
        };
        body = "";
      }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(withoutNewline);
      if (
        close &&
        close[1][0] === open.marker &&
        close[1].length >= open.count
      ) {
        const data: FencedBlock = {
          id: id([messageId, open.blockIndex, body]),
          messageId,
          origin,
          language: open.language,
          code: body,
          blockIndex: open.blockIndex,
          ...(open.sourceBinding ? { sourceBinding: open.sourceBinding } : {}),
          ...(open.sourceError ? { sourceError: open.sourceError } : {}),
        };
        blocks.push(data);
        open = null;
        body = "";
      } else body += line;
    }
  }
  return blocks;
}
