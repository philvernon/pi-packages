import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mapRenderedRegion,
  resolveTranscriptSymbol,
} from "../../src/native/transcript-source.ts";
import { transcriptSnapshot } from "../helpers.ts";
import type { SourceRegion } from "../../src/native/transcript-source.ts";

const text = 'const a = "界"; café;';
const uri = "file:///work/repo/src/example.ts";
const fileHash = createHash("sha256")
  .update(text + "\n")
  .digest("hex");

const snapshot = transcriptSnapshot({
  itemSemanticKey: "message:5",
  transcriptRevision: "r4",
  layoutRevision: "w80",
  renderedLines: ["heading", "    " + text],
  renderedStartRow: 34,
  visualCursor: { row: 35, col: 4 + text.indexOf("café") + 1 },
});
const regions = mapRenderedRegion(snapshot, {
  kind: "verified-file",
  origin: "structured-read",
  uri,
  fileHash,
  lines: [{ text, sourceLine: 8 }],
} satisfies SourceRegion);

test("production mapper resolves exact UTF-16 position after wide glyph without file IO", () => {
  assert.deepEqual(resolveTranscriptSymbol({ snapshot, regions }), {
    kind: "verified-file",
    origin: "structured-read",
    uri,
    fileHash,
    position: { line: 8, character: text.indexOf("café") },
    token: "café",
  });
});
test("production mapper rejects gutters, whitespace, punctuation and offscreen rows", () => {
  for (const cursor of [
    { row: 35, col: 0 },
    { row: 35, col: 9 },
    { row: 35, col: 12 },
    { row: 36, col: 20 },
    { row: 35, col: 1000 },
  ])
    assert.equal(
      resolveTranscriptSymbol({
        snapshot: { ...snapshot, visualCursor: cursor },
        regions,
      }),
      null,
    );
});
test("production mapper rejects stale transcript identity and reflow", () => {
  for (const changes of [
    { itemSemanticKey: "other" },
    { transcriptRevision: "r5" },
    { layoutRevision: "w40" },
  ])
    assert.equal(
      resolveTranscriptSymbol({
        snapshot: { ...snapshot, ...changes },
        regions,
      }),
      null,
    );
});
test("production mapper rejects duplicate source spans rather than selecting first", () => {
  assert.equal(
    resolveTranscriptSymbol({
      snapshot,
      regions: [...regions, ...regions],
    }),
    null,
  );
});
test("render map does not claim partial wrapped or truncated source lines", () => {
  assert.deepEqual(
    mapRenderedRegion(
      { ...snapshot, renderedLines: ["    " + text.slice(0, 10)] },
      {
        kind: "verified-file",
        uri,
        fileHash,
        lines: [{ text, sourceLine: 8 }],
      },
    ),
    [],
  );
});
test("unbound rendered symbols resolve only to workspace queries", () => {
  const regions = mapRenderedRegion(snapshot, {
    kind: "workspace-symbol-query",
    languageId: "typescript",
    lines: [{ text, sourceLine: 0 }],
  } satisfies SourceRegion);
  assert.deepEqual(resolveTranscriptSymbol({ snapshot, regions }), {
    kind: "workspace-symbol-query",
    token: "café",
    languageId: "typescript",
  });
});
