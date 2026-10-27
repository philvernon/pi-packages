import test from "node:test";
import assert from "node:assert/strict";
import { extractFencedBlocks, hideSourceAnnotations } from "../src/blocks.ts";

const TICK = String.fromCharCode(96);
const fence = TICK.repeat(3);

test("BL-01: extracts multiple fences in message order, retaining exact code and language", () => {
  const md =
    "Before\n" +
    fence +
    "ts\nconst a = 1;\n" +
    fence +
    '\nMiddle\n~~~python\nprint("hi")\n~~~\n';
  const blocks = extractFencedBlocks(md, {
    messageId: "m-1",
    origin: "assistant",
  });
  assert.deepEqual(
    blocks.map(({ language, code }) => ({ language, code })),
    [
      { language: "ts", code: "const a = 1;\n" },
      { language: "python", code: 'print("hi")\n' },
    ],
  );
  assert.equal(blocks[0].origin, "assistant");
  assert.equal(blocks[0].messageId, "m-1");
});

test("BL-02: a four-backtick fence does not close at three backticks", () => {
  const md =
    TICK.repeat(4) +
    "ts\nconst fence = 1;\n" +
    fence +
    "\nlet b = 2;\n" +
    TICK.repeat(4) +
    "\n";
  assert.equal(
    extractFencedBlocks(md, { messageId: "m-2" })[0].code,
    "const fence = 1;\n" + fence + "\nlet b = 2;\n",
  );
});

test("BL-03: a backtick fence is not closed by a tilde fence", () => {
  const md = fence + "js\nconst a = 1;\n~~~\nconst b = 2;\n" + fence + "\n";
  assert.equal(
    extractFencedBlocks(md, { messageId: "m-3" })[0].code,
    "const a = 1;\n~~~\nconst b = 2;\n",
  );
});

test("BL-04: unfinished fences are never presented as finalized code blocks", () => {
  assert.deepEqual(
    extractFencedBlocks(fence + "js\nunfinished", { messageId: "m-4" }),
    [],
  );
});

test("BL-05: language is parsed as label, not authoritative source metadata", () => {
  const result = extractFencedBlocks(
    fence + "ts file=/secrets.ts\nx\n" + fence + "\n",
    { messageId: "m-5" },
  );
  assert.equal(result[0].language, "ts");
  assert.equal(Reflect.get(result[0], "trustedPath"), undefined);
});

test("source annotations are parsed as untrusted zero-based file ranges", () => {
  const block = extractFencedBlocks(
    fence + 'ts source="src/a.ts" lines="42-43"\na\nb\n' + fence,
  )[0];
  assert.deepEqual(block.sourceBinding, {
    path: "src/a.ts",
    startLine: 41,
    endLine: 42,
  });
  assert.equal(Reflect.get(block, "trustedPath"), undefined);
});

test("malformed source annotations fail closed without throwing", () => {
  for (const info of [
    'ts source="a.ts"',
    'ts lines="1"',
    'ts source="a.ts" lines="0"',
    'ts source="a.ts" lines="3-1"',
    'ts source="a.ts" lines="99999999999999999999"',
  ]) {
    assert.equal(
      extractFencedBlocks(fence + info + "\nx\n" + fence)[0].sourceError,
      "invalid-annotation",
    );
  }
});

test("renderer hides fence metadata, including streaming openings, without changing code", () => {
  const opening = fence + 'ts source="src/a.ts" lines="1"';
  assert.equal(hideSourceAnnotations(opening), fence + "ts");
  assert.equal(
    hideSourceAnnotations(opening + '\nconst source="not metadata";\n' + fence),
    fence + 'ts\nconst source="not metadata";\n' + fence,
  );
  const nested =
    TICK.repeat(4) + "md\n" + opening + "\nx\n" + fence + "\n" + TICK.repeat(4);
  assert.equal(hideSourceAnnotations(nested), nested);
});

test("BL-06: empty code fences retain identity and code", () => {
  const result = extractFencedBlocks(fence + "text\n" + fence + "\n", {
    messageId: "m-6",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].code, "");
  assert.equal(typeof result[0].id, "string");
});

test("BL-07: block IDs differ for different messages and blocks", () => {
  const markdown =
    fence + "ts\na\n" + fence + "\n" + fence + "ts\na\n" + fence + "\n";
  const a = extractFencedBlocks(markdown, { messageId: "m-a" });
  const b = extractFencedBlocks(markdown, { messageId: "m-b" });
  assert.notEqual(a[0].id, a[1].id);
  assert.notEqual(a[0].id, b[0].id);
});
