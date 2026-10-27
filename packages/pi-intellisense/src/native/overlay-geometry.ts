import type { Cursor } from "../bridge/register.ts";
export interface TerminalSize {
  rows: number;
  cols: number;
}
export interface OverlayGeometry {
  terminal: TerminalSize;
  protectedRows?: { top: number; bottom: number };
}
export function placeHoverOverlay({
  anchor,
  tooltip,
  terminal,
  protectedRows = { top: 0, bottom: 0 },
}: OverlayGeometry & {
  anchor: Cursor;
  tooltip: { width: number; height: number };
}) {
  const top = Math.max(0, protectedRows.top || 0),
    bottom = Math.max(top + 1, terminal.rows - (protectedRows.bottom || 0));
  const width = Math.max(1, Math.min(tooltip.width, terminal.cols));
  let maxHeight = Math.max(1, Math.min(tooltip.height, bottom - top));
  const below = Math.max(0, bottom - anchor.row - 1);
  const above = Math.max(0, anchor.row - top);
  const useBelow = below >= maxHeight || below >= above;
  maxHeight = Math.max(1, Math.min(maxHeight, useBelow ? below : above));
  let row = useBelow ? anchor.row + 1 : anchor.row - maxHeight;
  const col = Math.max(0, Math.min(anchor.col, terminal.cols - width));
  row = Math.max(top, Math.min(row, bottom - maxHeight));
  return { row, col, width, maxHeight, anchor: "top-left" as const };
}
