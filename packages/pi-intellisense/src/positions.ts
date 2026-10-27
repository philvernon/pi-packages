import { Buffer } from "node:buffer";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface Position {
  line: number;
  character: number;
}

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export interface DisplayColumnOptions {
  tabSize?: number;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function lspToNvimByteColumn(
  line: string,
  character: number,
  encoding: PositionEncoding = "utf-16",
): number {
  if (!Number.isSafeInteger(character) || character < 0) {
    throw new RangeError("invalid LSP character position");
  }
  if (encoding === "utf-8") {
    const bytes = Buffer.from(line, "utf8");
    if (character > bytes.length)
      throw new RangeError("character position out of range");
    if (character < bytes.length && (bytes[character] & 0xc0) === 0x80) {
      throw new RangeError("invalid UTF-8 boundary");
    }
    return character;
  }
  if (encoding === "utf-32") {
    const points = Array.from(line);
    if (character > points.length)
      throw new RangeError("position out of range");
    return Buffer.byteLength(points.slice(0, character).join(""), "utf8");
  }
  if (encoding !== "utf-16")
    throw new TypeError("unsupported LSP position encoding");
  if (character > line.length) throw new RangeError("position out of range");
  const prev = line.charCodeAt(character - 1);
  const next = line.charCodeAt(character);
  if (
    character > 0 &&
    character < line.length &&
    prev >= 0xd800 &&
    prev <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    throw new RangeError("position splits UTF-16 surrogate pair");
  }
  return Buffer.byteLength(line.slice(0, character), "utf8");
}

export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

/** Terminal display-cell width, used to map prefixes in styled transcript lines. */
export function terminalCells(
  text: string,
  { tabSize = 4 }: DisplayColumnOptions = {},
): number {
  let col = 0;
  for (const { segment } of segmenter.segment(stripAnsi(text))) {
    const width =
      segment === "\t" ? tabSize - (col % tabSize) : visibleWidth(segment);
    col += width;
  }
  return col;
}
