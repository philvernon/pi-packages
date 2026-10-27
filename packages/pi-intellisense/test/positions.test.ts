import test from "node:test";
import assert from "node:assert/strict";
import { lspToNvimByteColumn } from "../src/positions.ts";

test("PO-01: ASCII UTF-16 column maps unchanged", () => {
  assert.equal(lspToNvimByteColumn("hello", 3, "utf-16"), 3);
});
test("PO-02: UTF-16 column counts accent and astral emoji correctly", () => {
  assert.equal(lspToNvimByteColumn("é🙂x", 3, "utf-16"), 6);
  assert.equal(lspToNvimByteColumn("é🙂x", 4, "utf-16"), 7);
});
test("PO-03: rejects offset inside UTF-16 surrogate pair", () => {
  assert.throws(
    () => lspToNvimByteColumn("a🙂b", 2, "utf-16"),
    /surrogate|invalid|boundary/i,
  );
});
test("PO-04: rejects out-of-range or negative offsets", () => {
  assert.throws(() => lspToNvimByteColumn("x", 2), /range|invalid/i);
  assert.throws(() => lspToNvimByteColumn("x", -1), /range|invalid/i);
});
test("PO-05: utf-8 negotiated byte position is not double encoded", () => {
  assert.equal(lspToNvimByteColumn("é🙂x", 6, "utf-8"), 6);
});
