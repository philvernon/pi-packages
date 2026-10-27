import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Snapshot } from "../bridge/register.ts";
import { stripAnsi } from "../positions.ts";
import { placeHoverOverlay, type OverlayGeometry } from "./overlay-geometry.ts";

export type NativeUI = Pick<ExtensionUIContext, "custom" | "notify">;

const backgroundColor = "customMessageBg";

export interface PopupContent {
  renderLines(width: number): string[];
  renderViewport(width: number, height: number): string[];
  handleInput(key: string, height: number): void;
  invalidate(): void;
}

function contentWidth(width: number): number {
  return Math.max(1, width - (width > 2 ? 2 : 0));
}

export async function showPopup<T>({
  ui,
  snapshot,
  signal,
  geometry,
  title,
  cancelledValue,
  onReturnToEditor,
  createContent,
}: {
  ui: NativeUI;
  snapshot: Snapshot;
  signal?: AbortSignal;
  geometry?: OverlayGeometry;
  title?: string;
  cancelledValue: T;
  onReturnToEditor?: () => void;
  createContent: (theme: Theme, done: (value: T) => void) => PopupContent;
}): Promise<T> {
  const anchor = snapshot.screenCursor;
  if (!anchor || signal?.aborted) return cancelledValue;
  let getOptions: () => ReturnType<typeof placeHoverOverlay>;
  let close: (() => void) | undefined;
  const cancel = () => close?.();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await ui.custom<T>(
      (tui, theme, _keys, done) => {
        close = () => done(cancelledValue);
        if (signal?.aborted) close();
        const content = createContent(theme, done);
        let columns = 0;
        let rows = 0;
        let options: ReturnType<typeof placeHoverOverlay> | undefined;

        getOptions = () => {
          const terminal = {
            cols: tui.terminal.columns,
            rows: tui.terminal.rows,
          };
          if (options && columns === terminal.cols && rows === terminal.rows)
            return options;
          columns = terminal.cols;
          rows = terminal.rows;
          const maxWidth = Math.max(1, terminal.cols - 4);
          const measured = content.renderLines(contentWidth(maxWidth));
          const measuredWidth = measured.reduce(
            (width, line) =>
              Math.max(width, visibleWidth(stripAnsi(line).trimEnd())),
            title ? visibleWidth(title) : 1,
          );
          const width = Math.min(maxWidth, measuredWidth + 2);
          const height =
            content.renderLines(contentWidth(width)).length + (title ? 1 : 0);
          options = placeHoverOverlay({
            anchor,
            terminal,
            protectedRows: geometry?.protectedRows ?? { top: 1, bottom: 5 },
            tooltip: { width, height: Math.max(1, height) },
          });
          return options;
        };

        function viewportHeight(): number {
          const { maxHeight } = getOptions();
          return maxHeight - (title && maxHeight > 1 ? 1 : 0);
        }

        return {
          render(width: number) {
            const { maxHeight } = getOptions();
            const innerWidth = contentWidth(width);
            const heading =
              title && maxHeight > 1 ? [theme.fg("accent", title)] : [];
            const lines = [
              ...heading,
              ...content.renderViewport(innerWidth, viewportHeight()),
            ];
            const padding = width > 2 ? " " : "";
            const background = theme.getBgAnsi(backgroundColor);
            return lines.slice(0, maxHeight).map((line) => {
              const fitted = truncateToWidth(line, innerWidth, "");
              const padded = truncateToWidth(
                padding + fitted + padding,
                width,
                "",
                true,
              );
              // Syntax highlighting and wrapping can reset the panel background.
              return theme.bg(
                backgroundColor,
                padded.replace(/\x1b\[(?:0|49)?m/gu, `$&${background}`),
              );
            });
          },
          handleInput(key: string) {
            if (matchesKey(key, Key.escape) || key === "escape")
              return close?.();
            if (matchesKey(key, Key.tab) || key === "tab") {
              close?.();
              onReturnToEditor?.();
              return;
            }
            content.handleInput(key, viewportHeight());
            tui.requestRender();
          },
          invalidate() {
            content.invalidate();
            options = undefined;
          },
        };
      },
      { overlay: true, overlayOptions: () => getOptions() },
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
