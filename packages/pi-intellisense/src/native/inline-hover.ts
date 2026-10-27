import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey } from "@earendil-works/pi-tui";
import type { Snapshot } from "../bridge/register.ts";
import { stripAnsi } from "../positions.ts";
import type { OverlayGeometry } from "./overlay-geometry.ts";
import { showPopup, type NativeUI } from "./popup.ts";

function sanitize(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

export async function showInlineHover({
  ui,
  snapshot,
  markup,
  geometry,
  signal,
  onReturnToEditor,
}: {
  ui: NativeUI;
  snapshot: Snapshot;
  markup: string;
  geometry?: OverlayGeometry;
  signal?: AbortSignal;
  onReturnToEditor?: () => void;
}): Promise<void> {
  return showPopup<void>({
    ui,
    snapshot,
    signal,
    geometry,
    cancelledValue: undefined,
    onReturnToEditor,
    createContent(theme) {
      const markdown = new Markdown(
        sanitize(markup).trim(),
        0,
        0,
        {
          ...getMarkdownTheme(),
          codeBlockBorder: () => "",
          codeBlockIndent: "",
        },
        { color: (text) => theme.fg("text", text) },
      );
      let top = 0;
      let lines: string[] = [];

      function renderLines(width: number): string[] {
        const rendered = markdown.render(width);
        let start = 0;
        let end = rendered.length;
        while (start < end && !stripAnsi(rendered[start]!).trim()) start++;
        while (end > start && !stripAnsi(rendered[end - 1]!).trim()) end--;
        if (start === end) {
          markdown.setText("No hover information");
          return renderLines(width);
        }
        lines = rendered.slice(start, end);
        return lines;
      }

      return {
        renderLines,
        renderViewport(width, height) {
          renderLines(width);
          top = Math.min(top, Math.max(0, lines.length - height));
          return lines.slice(top, top + height);
        },
        handleInput(key, height) {
          if (key === "j" || matchesKey(key, Key.down))
            top = Math.min(Math.max(0, lines.length - height), top + 1);
          if (key === "k" || matchesKey(key, Key.up))
            top = Math.max(0, top - 1);
        },
        invalidate() {
          markdown.invalidate();
        },
      };
    },
  });
}
