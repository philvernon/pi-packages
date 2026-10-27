import { stripAnsi, terminalCells, type Position } from "../positions.ts";
export type { Position } from "../positions.ts";
import type { Snapshot } from "../bridge/register.ts";

// Pi 1.3 renders tabs as three literal spaces, not terminal tab stops.
function expandedTabs(text: string) {
  return text.replace(/\t/gu, "   ");
}

export function symbolAtLine(
  displayed: string,
  line: string,
  cursorColumn: number,
  sourceStart = 0,
) {
  const text = expandedTabs(stripAnsi(displayed)),
    needle = expandedTabs(line).trimEnd();
  if (!needle) return null;
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) return null;
  const relative = cursorColumn - terminalCells(text.slice(0, at));
  for (const match of line.matchAll(/[\p{L}_$][\p{L}\p{N}\p{Mark}_$]*/gu)) {
    const start = terminalCells(expandedTabs(line.slice(0, match.index)));
    const end = start + terminalCells(match[0]);
    if (relative >= start && relative < end)
      return { token: match[0], character: sourceStart + match.index! };
  }
  return null;
}

export interface SourceLine {
  text: string;
  sourceLine: number;
  sourceCharacterStart?: number;
}
interface DisplayLine {
  displayRow: number;
  displayColStart: number;
  text: string;
  sourceLine: number;
  sourceCharacterStart: number;
}
interface VerifiedSource {
  kind: "verified-file";
  uri: string;
  fileHash: string;
  origin:
    "structured-read" | "annotated-fence" | "read-quote" | "workspace-symbol";
}
export interface WorkspaceSymbolQuery {
  kind: "workspace-symbol-query";
  token: string;
  languageId?: string;
}
export type SourceRegion = (
  VerifiedSource | Omit<WorkspaceSymbolQuery, "token">
) & { lines: SourceLine[] };
export type RenderedRegion = SourceRegion & {
  displayLines: DisplayLine[];
  itemSemanticKey: string;
  transcriptRevision: string;
  layoutRevision: string;
};
export type SourceAnchor = VerifiedSource & {
  position: Position;
  token: string;
};

export function mapRenderedRegion<T extends { lines: SourceLine[] }>(
  snapshot: Snapshot,
  region: T,
) {
  const rendered = snapshot.renderedLines?.map((line: string) =>
    stripAnsi(line),
  );
  if (
    !rendered ||
    !Number.isInteger(snapshot.renderedStartRow) ||
    !snapshot.visualCursor ||
    !region.lines.length ||
    region.lines.length > 2000
  )
    return [];
  const cursorRow = snapshot.visualCursor.row - snapshot.renderedStartRow;
  const first = Math.max(0, cursorRow - region.lines.length + 1);
  const last = Math.min(cursorRow, rendered.length - region.lines.length);
  const matches: Array<
    T & {
      displayLines: DisplayLine[];
      itemSemanticKey: string;
      transcriptRevision: string;
      layoutRevision: string;
    }
  > = [];
  for (let start = first; start <= last; start++) {
    const displayLines: DisplayLine[] = [];
    for (let offset = 0; offset < region.lines.length; offset++) {
      const row = region.lines[offset],
        display = rendered[start + offset];
      const needle = expandedTabs(row.text).trimEnd();
      if (!needle) {
        if (display.trim()) break;
      }
      const at = needle ? display.indexOf(needle) : 0;
      if (
        at < 0 ||
        (needle && display.indexOf(needle, at + 1) >= 0) ||
        display.slice(at + needle.length).trim()
      )
        break;
      if (display.slice(0, at).trim()) break;
      displayLines.push({
        displayRow: snapshot.renderedStartRow + start + offset,
        displayColStart: terminalCells(display.slice(0, at)),
        text: row.text,
        sourceLine: row.sourceLine,
        sourceCharacterStart: row.sourceCharacterStart ?? 0,
      });
    }
    if (displayLines.length === region.lines.length) {
      matches.push({
        ...region,
        displayLines,
        itemSemanticKey: snapshot.itemSemanticKey,
        transcriptRevision: snapshot.transcriptRevision,
        layoutRevision: snapshot.layoutRevision,
      });
      if (matches.length === 2) break;
    }
  }
  return matches;
}

export function resolveTranscriptSymbol({
  snapshot,
  regions,
}: {
  snapshot: Snapshot;
  regions: RenderedRegion[];
}): SourceAnchor | WorkspaceSymbolQuery | null {
  if (!snapshot?.visualCursor) return null;
  const cursor = snapshot.visualCursor;
  const matches = regions.flatMap((region) => {
    if (
      region.itemSemanticKey !== snapshot.itemSemanticKey ||
      region.transcriptRevision !== snapshot.transcriptRevision ||
      region.layoutRevision !== snapshot.layoutRevision
    )
      return [];
    const line = region.displayLines?.find(
      (row) => row.displayRow === cursor.row,
    );
    if (!line) return [];
    const position = symbolAtLine(
      line.text,
      line.text,
      cursor.col - line.displayColStart,
      line.sourceCharacterStart,
    );
    return position ? [{ region, line, position }] : [];
  });
  if (matches.length !== 1) return null;
  const { region, line, position } = matches[0];
  if (region.kind === "workspace-symbol-query")
    return {
      kind: region.kind,
      token: position.token,
      languageId: region.languageId,
    };
  return {
    kind: region.kind,
    uri: region.uri,
    fileHash: region.fileHash,
    origin: region.origin,
    position: { line: line.sourceLine, character: position.character },
    token: position.token,
  };
}

interface FenceBlock {
  blockIndex: number;
  code: string;
  language: string;
}
export function mapRenderedFence(
  snapshot: Snapshot,
  block: FenceBlock,
  blocks: FenceBlock[],
) {
  const rendered = snapshot.renderedLines?.map((line: string) =>
    stripAnsi(line).trimEnd(),
  );
  if (!rendered) return [];
  const fences: Array<{ start: number; end: number; language: string }> = [];
  let open: { start: number; prefix: string; language: string } | undefined;
  for (let row = 0; row < rendered.length; row++) {
    const line = rendered[row];
    if (open) {
      if (line === open.prefix + "```") {
        fences.push({ start: open.start, end: row, language: open.language });
        open = undefined;
      }
    } else {
      const match = /^( *)```([^`]*)$/u.exec(line);
      if (match)
        open = {
          start: row,
          prefix: match[1],
          language: match[2].trim().split(/\s/u)[0],
        };
    }
  }
  if (
    open ||
    fences.length !== blocks.length ||
    fences.some((fence, i) => fence.language !== blocks[i].language)
  )
    return [];
  const fence = fences[block.blockIndex];
  const lines = block.code
    .replace(/\r\n/gu, "\n")
    .replace(/\n$/u, "")
    .split("\n");
  if (!fence || fence.end - fence.start - 1 !== lines.length) return [];
  return mapRenderedRegion(
    {
      ...snapshot,
      renderedLines: snapshot.renderedLines.slice(fence.start + 1, fence.end),
      renderedStartRow: snapshot.renderedStartRow + fence.start + 1,
    },
    {
      lines: lines.map((text: string, sourceLine: number) => ({
        text,
        sourceLine,
      })),
    },
  );
}
