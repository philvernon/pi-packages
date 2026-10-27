import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocations, validateFileLocation } from "../src/locations.ts";

const start = { line: 9, character: 3 };
const end = { line: 9, character: 7 };
const loc = (uri: string, line = 9) => ({
  uri,
  range: { start: { line, character: 3 }, end },
});
const fs = {
  async stat(path: string) {
    return { isFile: () => path !== "/project/src/directory.ts" };
  },
  async realpath(path: string) {
    if (
      path === "/project/src/valid.ts" ||
      path === "/project/src/a | echo hacked.ts" ||
      path === "/project/src/directory.ts"
    )
      return path;
    if (path === "/project/src/symlink.ts") return "/etc/passwd";
    if (path === "/project-evil/src/fake.ts") return path;
    throw new Error("ENOENT");
  },
};

test("LO-01: normalizes null and single location", () => {
  assert.deepEqual(normalizeLocations(null), []);
  const result = normalizeLocations(loc("file:///project/src/valid.ts"));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].selectionRange.start, start);
});

test("LO-02: LocationLink uses targetSelectionRange and targetUri", () => {
  const result = normalizeLocations([
    {
      originSelectionRange: { start: { line: 1, character: 0 }, end },
      targetUri: "file:///project/src/valid.ts",
      targetRange: { start: { line: 20, character: 0 }, end },
      targetSelectionRange: { start: { line: 21, character: 4 }, end },
    },
  ]);
  assert.equal(result[0].uri, "file:///project/src/valid.ts");
  assert.deepEqual(result[0].selectionRange.start, { line: 21, character: 4 });
});

test("LO-03: dedupes identical targets but preserves distinct positions", () => {
  const result = normalizeLocations([
    loc("file:///project/src/valid.ts", 9),
    loc("file:///project/src/valid.ts", 9),
    loc("file:///project/src/valid.ts", 11),
  ]);
  assert.equal(result.length, 2);
});

test("LO-04: validates percent-encoded URI and canonical allowed file", async () => {
  const result = await validateFileLocation(
    loc("file:///project/src/a%20%7C%20echo%20hacked.ts"),
    { root: "/project", fs },
  );
  assert.equal(result.path, "/project/src/a | echo hacked.ts");
});

test("LO-05: rejects non-file schemes", async () => {
  await assert.rejects(
    () =>
      validateFileLocation(loc("javascript:alert(1)"), {
        root: "/project",
        fs,
      }),
    /scheme|file|URI/i,
  );
  await assert.rejects(
    () =>
      validateFileLocation(loc("https://example.com/x.ts"), {
        root: "/project",
        fs,
      }),
    /scheme|file|URI/i,
  );
});

test("LO-06: blocks directory prefix collision", async () => {
  await assert.rejects(
    () =>
      validateFileLocation(loc("file:///project-evil/src/fake.ts"), {
        root: "/project",
        fs,
      }),
    /outside|trusted|workspace|root/i,
  );
});

test("LO-07: symlink target outside trusted root is rejected", async () => {
  await assert.rejects(
    () =>
      validateFileLocation(loc("file:///project/src/symlink.ts"), {
        root: "/project",
        fs,
      }),
    /outside|trusted|workspace|root/i,
  );
});

test("LO-08: nonexistent destination is not treated as new file", async () => {
  await assert.rejects(
    () =>
      validateFileLocation(loc("file:///project/nope.ts"), {
        root: "/project",
        fs,
      }),
    /ENOENT|missing|exist/i,
  );
});

test("invalid positions and directory targets are rejected before launching an editor", async () => {
  for (const position of [
    { line: -1, character: 0 },
    { line: 0, character: -1 },
    { line: NaN, character: 0 },
  ]) {
    await assert.rejects(
      validateFileLocation(
        { uri: "file:///project/src/valid.ts", range: { start: position } },
        { root: "/project", fs },
      ),
      /position/,
    );
  }
  await assert.rejects(
    validateFileLocation(loc("file:///project/src/directory.ts"), {
      root: "/project",
      fs,
    }),
    /regular file/,
  );
});
