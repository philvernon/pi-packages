import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTranscriptProvenance } from "../src/native/provenance-resolver.ts";
import { symbolAtLine } from "../src/native/transcript-source.ts";
import { hideSourceAnnotations } from "../src/blocks.ts";
import type { Snapshot } from "../src/bridge/register.ts";

async function workspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-prov-"));
  try {
    await mkdir(path.join(root, "src"));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function snapshot(
  sourceText: string | undefined,
  code: string,
  {
    row = 0,
    token = "state",
    ...changes
  }: Partial<Snapshot> & { row?: number; token?: string } = {},
): Snapshot & { itemText?: string } {
  const tool = changes.itemKind === "tool",
    start = tool ? 1 : 2;
  const renderedLines = tool
    ? ["Explanation", ...code.split("\n").map((line) => "  " + line), ""]
    : [
        "Explanation",
        "```ts",
        ...code.split("\n").map((line) => "  " + line),
        "```",
        "",
      ];
  return {
    version: 1,
    sessionId: "s1",
    itemKind: "message",
    itemSemanticKey: "message:one",
    sourceText,
    transcriptRevision: "r1",
    layoutRevision: "w80",
    renderedLines,
    renderedStartRow: 10,
    visualCursor: {
      row: 10 + start + row,
      col: renderedLines[start + row].indexOf(token) + 1,
    },
    ...changes,
  };
}
const fence = (code: string, annotation = 'source="src/a.ts" lines="2-3"') =>
  "```ts " + annotation + "\n" + code + "\n```";
const code = "const state = 12;\nconsole.log(state);";

async function verified(
  ...args: Parameters<typeof resolveTranscriptProvenance>
) {
  const result = await resolveTranscriptProvenance(...args);
  assert.ok(result.kind === "verified-file");
  return result;
}

async function unmapped(
  ...args: Parameters<typeof resolveTranscriptProvenance>
) {
  const result = await resolveTranscriptProvenance(...args);
  assert.ok(result.kind === "unmapped");
  return result;
}

test("annotated fence verifies the entire range and maps the actual rendered cursor", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), "// header\n" + code + "\n");
    const raw = fence(code),
      s = snapshot(raw, code, { row: 1 });
    assert.ok(!hideSourceAnnotations(raw).includes("source="));
    const result = await resolveTranscriptProvenance(s, { root });
    assert.ok(result.kind === "verified-file");
    assert.equal(result.origin, "annotated-fence");
    assert.deepEqual(result.position, { line: 2, character: 12 });
    assert.equal(result.token, "state");
  }));

test("source annotation chooses the stated range even when identical code appears twice", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code + "\n" + code + "\n");
    const result = await verified(
      snapshot(fence(code, 'source="src/a.ts" lines="3-4"'), code, { row: 1 }),
      { root },
    );
    assert.deepEqual(result.position, { line: 3, character: 12 });
  }));

test("repeated lines within one block resolve by rendered row, not first string match", () =>
  workspace(async (root) => {
    const repeated = "state();\nstate();";
    await writeFile(path.join(root, "src/a.ts"), repeated + "\n");
    const result = await verified(
      snapshot(fence(repeated, 'source="src/a.ts" lines="1-2"'), repeated, {
        row: 1,
      }),
      { root },
    );
    assert.deepEqual(result.position, { line: 1, character: 0 });
  }));

test("wrong file text, wrong ranges and malformed annotations cannot fall back to workspace search", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), "// header\n" + code + "\n");
    for (const [annotation, expected] of [
      ['source="src/a.ts" lines="1-2"', "stale-source"],
      ['source="src/a.ts" lines="2"', "stale-source"],
      ['source="src/a.ts" lines="3-2"', "invalid-annotation"],
      ['source="src/a.ts"', "invalid-annotation"],
      ['source="missing.ts" lines="2-3"', "source-unavailable"],
    ]) {
      const result = await resolveTranscriptProvenance(
        snapshot(fence(code, annotation), code),
        { root },
      );
      assert.deepEqual(result, { kind: "unmapped", reason: expected });
    }
  }));

test("changed line elsewhere in an annotated range rejects the whole snippet", () =>
  workspace(async (root) => {
    await writeFile(
      path.join(root, "src/a.ts"),
      "// header\nconst state = 99;\nconsole.log(state);\n",
    );
    assert.equal(
      (await unmapped(snapshot(fence(code), code, { row: 1 }), { root }))
        .reason,
      "stale-source",
    );
  }));

test("read provenance binds to exact tool call and respects raw read offset", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), "// header\n" + code + "\n");
    await writeFile(path.join(root, "src/b.ts"), code + "\n");
    const entries = [
      ...readEntries("first", "src/b.ts", code),
      ...readEntries("second", "src/a.ts", code, 2),
    ];
    const s = snapshot(undefined, code, {
      row: 1,
      itemKind: "tool",
      toolCallId: "second",
      itemSemanticKey: "tool:second:0",
    });
    const result = await resolveTranscriptProvenance(s, { root, entries });
    assert.ok(result.kind === "verified-file");
    assert.match(result.uri, /\/a.ts$/);
    assert.deepEqual(result.position, { line: 2, character: 12 });
    assert.equal(
      (await unmapped({ ...s, toolCallId: "missing" }, { root, entries }))
        .reason,
      "source-unknown",
    );
  }));
function readEntries(id: string, file: string, content: string, offset = 1) {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: "read",
            arguments: { path: file, offset } as {
              path: string;
              offset: number;
              limit?: number;
            },
          },
        ],
      },
    },
    {
      type: "message",
      id: "result-" + id,
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: id,
        content: [{ type: "text", text: content }],
      },
    },
  ] as const;
}

test("number-like raw source text is never stripped to match a different file", () =>
  workspace(async (root) => {
    const numbered = "1: const state = 12;\n2: console.log(state);";
    await writeFile(path.join(root, "src/a.ts"), numbered + "\n");
    const entries = readEntries("read1", "src/a.ts", numbered);
    const s = snapshot(undefined, numbered, {
      row: 1,
      itemKind: "tool",
      toolCallId: "read1",
    });
    assert.deepEqual((await verified(s, { root, entries })).position, {
      line: 1,
      character: 15,
    });
    await writeFile(path.join(root, "src/a.ts"), code);
    assert.equal((await unmapped(s, { root, entries })).reason, "stale-source");
  }));

test("ordinary generated fence requests workspace search even when prose mentions an existing file", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code + "\n");
    const s = snapshot("See src/a.ts\n" + fence(code, ""), code, { row: 1 });
    const result = await resolveTranscriptProvenance(s, { root });
    assert.deepEqual(result, {
      kind: "workspace-symbol-query",
      token: "state",
      languageId: "typescript",
    });
  }));

test("original Markdown is required; rendered fences cannot invent provenance", () =>
  workspace(async (root) => {
    const s = snapshot(undefined, code);
    s.itemText = fence(code);
    assert.equal((await unmapped(s, { root })).reason, "source-unknown");
  }));

test("wrapped or truncated blocks fail closed instead of matching a surviving line", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), "// header\n" + code + "\n");
    const s = snapshot(fence(code), code, { row: 1 });
    s.renderedLines[2] = "  const state =";
    s.renderedLines.splice(3, 0, "  12;");
    s.visualCursor!.row = 14;
    assert.equal((await unmapped(s, { root })).reason, "wrapped-unmappable");
  }));

test("unsafe paths and symlinks cannot bind outside workspace", () =>
  workspace(async (root) => {
    await symlink(path.join(root, ".."), path.join(root, "outside"));
    for (const file of ["../secret.ts", "/etc/passwd", "outside/secret.ts"]) {
      const result = await resolveTranscriptProvenance(
        snapshot(
          fence(code, `source=${JSON.stringify(file)} lines="1-2"`),
          code,
        ),
        { root },
      );
      assert.ok(result.kind === "unmapped");
      assert.equal(result.reason, "source-unavailable");
    }
  }));

test("Unicode cells, combining marks and expanded tabs preserve UTF-16 coordinates", () =>
  workspace(async (root) => {
    const line = '\tconst c = "界😃"; café();';
    await writeFile(path.join(root, "src/a.ts"), line + "\n");
    const display = '   const c = "界😃"; café();';
    const s = snapshot(fence(line, 'source="src/a.ts" lines="1"'), display, {
      token: "café",
    });
    // Two wide glyphs before the symbol add one terminal cell relative to UTF-16.
    s.visualCursor!.col = 2 + display.indexOf("café") + 1;
    const result = await resolveTranscriptProvenance(s, { root });
    assert.ok(result.kind === "verified-file");
    assert.equal(result.token, "café");
    assert.equal(result.position.character, line.indexOf("café"));
    assert.equal(
      symbolAtLine("  const state = 1;", "const state = 1;", 7),
      null,
    );
  }));

test("Pi's fixed three-space tab rendering maps tabs inside a line without snapping whitespace to a symbol", () =>
  workspace(async (root) => {
    const line = "const state\t= state;";
    await writeFile(path.join(root, "src/a.ts"), line + "\n");
    const rendered = line.replace(/\t/gu, "   ");
    const s = snapshot(fence(line, 'source="src/a.ts" lines="1"'), rendered);
    s.visualCursor!.col = 2 + rendered.lastIndexOf("state") + 1;
    assert.deepEqual((await verified(s, { root })).position, {
      line: 0,
      character: line.lastIndexOf("state"),
    });
    s.visualCursor!.col = 2 + rendered.indexOf("   ") + 1;
    assert.equal((await unmapped(s, { root })).reason, "cursor-not-symbol");
  }));

test("an annotated fence cannot lend its source identity to identical prose", () =>
  workspace(async (root) => {
    const line = "state();";
    await writeFile(path.join(root, "src/a.ts"), line + "\n");
    const s = snapshot(
      fence(line, 'source="src/a.ts" lines="1"') + "\n" + line,
      line,
    );
    s.renderedLines.push(line);
    s.visualCursor = { row: 10 + s.renderedLines.length - 1, col: 1 };
    assert.equal(
      (await resolveTranscriptProvenance(s, { root })).kind,
      "unmapped",
    );
  }));

test("identical fences bind to their own rendered block and annotation, not another fence", () =>
  workspace(async (root) => {
    const line = "state();";
    await writeFile(path.join(root, "src/a.ts"), line + "\n");
    await writeFile(path.join(root, "src/b.ts"), line + "\n");
    const raw =
      fence(line, 'source="src/a.ts" lines="1"') +
      "\n" +
      fence(line, 'source="src/b.ts" lines="1"');
    const s = snapshot(raw, line);
    s.renderedLines = [
      "```ts",
      "  " + line,
      "```",
      "",
      "```ts",
      "  " + line,
      "```",
    ];
    s.visualCursor = { row: 15, col: 3 };
    assert.match((await verified(s, { root })).uri, /\/b.ts$/);
  }));

test("read paths follow Pi's @ prefix and tilde expansion instead of literal lookalike filenames", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code + "\n");
    await mkdir(path.join(root, "@src"));
    await writeFile(path.join(root, "@src/a.ts"), code + "\n");
    const home = process.env.HOME;
    try {
      process.env.HOME = root;
      for (const file of ["@src/a.ts", "~/src/a.ts"]) {
        const s = snapshot(undefined, code, {
          itemKind: "tool",
          toolCallId: "read1",
        });
        const result = await resolveTranscriptProvenance(s, {
          root,
          entries: readEntries("read1", file, code),
        });
        assert.ok(result.kind === "verified-file");
        assert.match(result.uri, /\/src\/a.ts$/);
        assert.ok(!result.uri.includes("@src"));
      }
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  }));

test("known native read limit notices are verified using actual call arguments, not guessed formatting", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code + "\n");
    const first = code.split("\n")[0],
      output = first + "\n\n[2 more lines in file. Use offset=2 to continue.]";
    const entries = readEntries("read1", "src/a.ts", output);
    entries[0].message.content[0].arguments.limit = 1;
    const s = snapshot(undefined, output, {
      itemKind: "tool",
      toolCallId: "read1",
    });
    assert.equal(
      (await resolveTranscriptProvenance(s, { root, entries })).kind,
      "verified-file",
    );
    delete entries[0].message.content[0].arguments.limit;
    assert.equal((await unmapped(s, { root, entries })).reason, "stale-source");
  }));

test("text-presentation pictographs use Pi widths and cannot shift punctuation onto a symbol", () =>
  workspace(async (root) => {
    const line = 'const copyright = "©"; state();';
    await writeFile(path.join(root, "src/a.ts"), line + "\n");
    const s = snapshot(fence(line, 'source="src/a.ts" lines="1"'), line);
    s.visualCursor!.col = 2 + line.indexOf("state");
    assert.equal((await verified(s, { root })).token, "state");
    s.visualCursor!.col += 5;
    assert.equal((await unmapped(s, { root })).reason, "cursor-not-symbol");
  }));

test("a native limit notice identical to unread source text never inherits that text's provenance", () =>
  workspace(async (root) => {
    const output =
      "state();\n\n[2 more lines in file. Use offset=2 to continue.]";
    await writeFile(path.join(root, "src/a.ts"), output);
    const entries = readEntries("read1", "src/a.ts", output);
    entries[0].message.content[0].arguments.limit = 1;
    const s = snapshot(undefined, output, {
      itemKind: "tool",
      toolCallId: "read1",
    });
    assert.equal(
      (await resolveTranscriptProvenance(s, { root, entries })).kind,
      "verified-file",
    );
    s.visualCursor = { row: 13, col: 5 };
    assert.equal(
      (await resolveTranscriptProvenance(s, { root, entries })).kind,
      "unmapped",
    );
  }));

test("an ordinary assistant quote recovers its real file and position from a prior read", () =>
  workspace(async (root) => {
    const content = 'import { state } from "./state.js";\n\n' + code + "\n";
    await writeFile(path.join(root, "src/a.ts"), content);
    const entries = readEntries("r1", "src/a.ts", content);
    const result = await resolveTranscriptProvenance(
      snapshot(fence(code, ""), code, { row: 1 }),
      { root, entries },
    );
    assert.ok(result.kind === "verified-file");
    assert.equal(result.origin, "read-quote");
    assert.match(result.uri, /\/src\/a.ts$/);
    assert.deepEqual(result.position, { line: 3, character: 12 });
  }));

test("quotes may remove common indentation without losing real UTF-16 columns", () =>
  workspace(async (root) => {
    const original =
      "class Store {\n\t  const state = 12;\n\t  console.log(state);\n}\n";
    await writeFile(path.join(root, "src/a.ts"), original);
    const result = await resolveTranscriptProvenance(
      snapshot(fence(code, ""), code, { row: 1 }),
      {
        root,
        entries: readEntries("r1", "src/a.ts", original),
      },
    );
    assert.ok(result.kind === "verified-file");
    assert.deepEqual(result.position, { line: 2, character: 15 });
  }));

test("extra quote indentation also maps back to the real source column", () =>
  workspace(async (root) => {
    const quote = code
      .split("\n")
      .map((line) => "    " + line)
      .join("\n");
    await writeFile(path.join(root, "src/a.ts"), code);
    const result = await resolveTranscriptProvenance(
      snapshot(fence(quote, ""), quote, { row: 1 }),
      {
        root,
        entries: readEntries("r1", "src/a.ts", code),
      },
    );
    assert.ok(result.kind === "verified-file");
    assert.deepEqual(result.position, { line: 1, character: 12 });
  }));

test("a known source file supplies language context even without a fence language", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code);
    const s = snapshot("```\n" + code + "\n```", code, { row: 1 });
    s.renderedLines[1] = "```";
    const result = await resolveTranscriptProvenance(s, {
      root,
      entries: readEntries("r1", "src/a.ts", code),
    });
    assert.ok(result.kind === "verified-file");
    assert.deepEqual(result.position, { line: 1, character: 12 });
  }));

test("duplicate quote locations in different read files defer to workspace resolution", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code);
    await writeFile(path.join(root, "src/b.ts"), code);
    const entries = [
      ...readEntries("r1", "src/a.ts", code),
      ...readEntries("r2", "src/b.ts", code),
    ];
    assert.deepEqual(
      await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
        root,
        entries,
      }),
      {
        kind: "workspace-symbol-query",
        token: "state",
        languageId: "typescript",
      },
    );
  }));

test("repeated reads and aliases of the same location do not create ambiguity", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code);
    await symlink("a.ts", path.join(root, "src/alias.ts"));
    const entries = [
      ...readEntries("r1", "src/a.ts", code),
      ...readEntries("r2", "@src/a.ts", code),
      ...readEntries("r3", "src/alias.ts", code),
    ];
    assert.equal(
      (
        await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
          root,
          entries,
        })
      ).kind,
      "verified-file",
    );
  }));

test("repeated code in one read is ambiguous, but a partial read supplies a unique location", () =>
  workspace(async (root) => {
    const content = code + "\n\n" + code;
    await writeFile(path.join(root, "src/a.ts"), content);
    const s = snapshot(fence(code, ""), code, { row: 1 });
    assert.deepEqual(
      await resolveTranscriptProvenance(s, {
        root,
        entries: readEntries("all", "src/a.ts", content),
      }),
      {
        kind: "workspace-symbol-query",
        token: "state",
        languageId: "typescript",
      },
    );
    const entries = readEntries("partial", "src/a.ts", code, 4);
    assert.deepEqual((await verified(s, { root, entries })).position, {
      line: 4,
      character: 12,
    });
  }));

test("stale read-backed quotes defer to current workspace resolution", () =>
  workspace(async (root) => {
    await writeFile(
      path.join(root, "src/a.ts"),
      "const state = 99;\nconsole.log(state);",
    );
    const s = snapshot(fence(code, ""), code, { row: 1 });
    assert.deepEqual(
      await resolveTranscriptProvenance(s, {
        root,
        entries: readEntries("r1", "src/a.ts", code),
      }),
      {
        kind: "workspace-symbol-query",
        token: "state",
        languageId: "typescript",
      },
    );
  }));

test("a stale candidate in another file cannot silently lend its quote to the remaining valid file", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code);
    await writeFile(path.join(root, "src/b.ts"), "changed();");
    const entries = [
      ...readEntries("r1", "src/a.ts", code),
      ...readEntries("r2", "src/b.ts", code),
    ];
    assert.deepEqual(
      await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
        root,
        entries,
      }),
      {
        kind: "workspace-symbol-query",
        token: "state",
        languageId: "typescript",
      },
    );
  }));

test("a fresh read can validate a location also present in older stale read history", () =>
  workspace(async (root) => {
    const content = code + "\n// current";
    await writeFile(path.join(root, "src/a.ts"), content);
    const entries = [
      ...readEntries("old", "src/a.ts", code + "\n// old"),
      ...readEntries("new", "src/a.ts", content),
    ];
    assert.equal(
      (
        await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
          root,
          entries,
        })
      ).kind,
      "verified-file",
    );
  }));

test("unread portions of a known file do not invent source identity for a quote", () =>
  workspace(async (root) => {
    const content = "// header\n" + code;
    await writeFile(path.join(root, "src/a.ts"), content);
    const entries = readEntries("partial", "src/a.ts", "// header", 1);
    assert.deepEqual(
      await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
        root,
        entries,
      }),
      {
        kind: "workspace-symbol-query",
        token: "state",
        languageId: "typescript",
      },
    );
  }));

test("failed or natively truncated read results cannot supply automatic quote provenance", () =>
  workspace(async (root) => {
    await writeFile(path.join(root, "src/a.ts"), code);
    for (const details of [
      { isError: true },
      { details: { truncation: { truncated: true } } },
    ]) {
      const entries = readEntries("r1", "src/a.ts", code);
      Object.assign(entries[1].message, details);
      assert.deepEqual(
        await resolveTranscriptProvenance(snapshot(fence(code, ""), code), {
          root,
          entries,
        }),
        {
          kind: "workspace-symbol-query",
          token: "state",
          languageId: "typescript",
        },
      );
    }
  }));

test("unbound fences map Unicode tokens using terminal cells without creating a document", () =>
  workspace(async (root) => {
    const line = '\tconst c = "界😃"; café();';
    const display = line.replace(/\t/gu, "   ");
    const s = snapshot(fence(line, ""), display, { token: "café" });
    s.visualCursor!.col = 2 + display.indexOf("café") + 1;
    assert.deepEqual(await resolveTranscriptProvenance(s, { root }), {
      kind: "workspace-symbol-query",
      token: "café",
      languageId: "typescript",
    });
    s.visualCursor!.col += 5;
    assert.equal((await unmapped(s, { root })).reason, "cursor-not-symbol");
  }));

test("unbound fences without a supported language retain unmappable fallback policy", () =>
  workspace(async (root) => {
    for (const language of ["", "unknown"]) {
      const s = snapshot("```" + language + "\n" + code + "\n```", code);
      s.renderedLines[1] = "```" + language;
      assert.equal((await unmapped(s, { root })).reason, "wrapped-unmappable");
    }
  }));
