import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../src/positions.ts";
import type { NativeUI } from "../../src/native/popup.ts";
import { transcriptSnapshot } from "../helpers.ts";
import {
  customUI,
  mountComponent,
  type CustomOptions,
  type TestComponent,
} from "../ui-helpers.ts";

const projection = () => import("../../src/native/overlay-geometry.ts");
const popup = () => import("../../src/native/inline-hover.ts");

const terminal = { rows: 42, cols: 120 };

test("NT-02: popup is below the symbol, within edges and outside fixed prompt/status rows", async () => {
  const { placeHoverOverlay } = await projection();
  const options = placeHoverOverlay({
    anchor: { row: 16, col: 20 },
    terminal,
    tooltip: { width: 54, height: 14 },
    protectedRows: { top: 2, bottom: 4 },
  });
  assert.equal(options.row, 17);
  assert.equal(options.col, 20);
  assert.ok(options.col + options.width <= 120);
  assert.ok(options.row + options.maxHeight <= 38);
  assert.notEqual(options.anchor, "center");
});

test("NT-02: popup flips above the symbol near the right/bottom edges", async () => {
  const { placeHoverOverlay } = await projection();
  const options = placeHoverOverlay({
    anchor: { row: 35, col: 115 },
    terminal,
    tooltip: { width: 50, height: 12 },
    protectedRows: { top: 2, bottom: 4 },
  });
  assert.ok(options.col < 115);
  assert.ok(options.row < 35);
  assert.ok(options.col >= 0);
  assert.ok(options.row + options.maxHeight <= 38);
});

test("hover placement prefers the row below the symbol and stays within the right edge", async () => {
  const { placeHoverOverlay } = await projection();
  const options = placeHoverOverlay({
    anchor: { row: 16, col: 115 },
    terminal,
    tooltip: { width: 54, height: 14 },
    protectedRows: { top: 2, bottom: 4 },
  });
  assert.equal(options.row, 17);
  assert.equal(options.col, 66);
  assert.equal(options.maxHeight, 14);
});

test("hover placement flips above near the bottom and bounds tall content without covering the symbol", async () => {
  const { placeHoverOverlay } = await projection();
  for (const height of [12, 100]) {
    const options = placeHoverOverlay({
      anchor: { row: 35, col: 20 },
      terminal,
      tooltip: { width: 54, height },
      protectedRows: { top: 2, bottom: 4 },
    });
    assert.ok(options.row >= 2);
    assert.equal(options.row + options.maxHeight, 35);
    assert.equal(options.col, 20);
  }
});

test("NT-02: K uses Pi overlay:true and NEVER replaces the transcript or opens /intel", async () => {
  const { showInlineHover } = await popup();
  const call: { options?: CustomOptions; component?: TestComponent } = {};
  const ui = {
    notify() {},
    custom: customUI((factory, options) => {
      call.options = options;
      call.component = mountComponent(factory);
      return Promise.resolve();
    }),
    setEditorComponent() {
      throw new Error("cannot replace the Pi editor");
    },
    sendUserMessage() {
      throw new Error("hover must not trigger the model");
    },
  };
  await showInlineHover({
    ui,
    snapshot: transcriptSnapshot({
      sessionId: "s",
      itemSemanticKey: "message:4",
      visualCursor: { row: 53, col: 18 },
      screenCursor: { row: 16, col: 20 },
    }),
    markup: "(alias) function calculateTotal(): number",
    geometry: { terminal, protectedRows: { top: 2, bottom: 4 } },
  });
  assert.equal(call.options?.overlay, true);
  const getOverlay = call.options?.overlayOptions;
  assert.ok(typeof getOverlay === "function");
  const overlay = getOverlay();
  assert.equal(typeof overlay.row, "number");
  assert.equal(typeof overlay.col, "number");
  assert.ok(Number(overlay.width) > 0);
  assert.ok(call.component!.render(70).join("\n").includes("calculateTotal"));
});

test("NT-03: Esc dismisses only tooltip; same transcript cursor and yank state survive", async () => {
  const { showInlineHover } = await popup();
  const state = {
    mode: "visual",
    item: "message:4",
    row: 53,
    col: 18,
    scrollTop: 40,
    yank: "existing yank",
    selection: { anchor: 10, head: 18 },
  };
  let component!: TestComponent;
  let dismissed = false;
  const before = structuredClone(state);
  const ui: NativeUI = {
    notify() {},
    custom: customUI((factory, options) => {
      assert.equal(options?.overlay, true);
      component = mountComponent(factory, () => {
        dismissed = true;
      });
      return Promise.resolve();
    }),
  };
  await showInlineHover({
    ui,
    snapshot: transcriptSnapshot({
      sessionId: "s",
      itemSemanticKey: "message:4",
      screenCursor: { row: 16, col: 20 },
      visualCursor: { row: 53, col: 18 },
    }),
    markup: "Hover docs",
    geometry: { terminal, protectedRows: { top: 2, bottom: 4 } },
  });
  component.handleInput("\x1b");
  assert.equal(dismissed, true);
  assert.deepEqual(
    state,
    before,
    "hover/escape must not reset transcript or selection state",
  );
});

test("Focus-P0: Tab on a capturing hover closes it and returns to the Pi editor", async () => {
  const { showInlineHover } = await popup();
  let component!: TestComponent;
  let done = 0,
    returned = 0;
  const ui: NativeUI = {
    notify() {},
    custom: customUI((factory, options) => {
      assert.equal(options?.overlay, true);
      component = mountComponent(factory, () => {
        done++;
      });
      return Promise.resolve();
    }),
  };
  await showInlineHover({
    ui,
    snapshot: transcriptSnapshot({ screenCursor: { row: 9, col: 10 } }),
    markup: "Hover",
    geometry: {
      terminal: { rows: 35, cols: 100 },
      protectedRows: { top: 1, bottom: 5 },
    },
    onReturnToEditor: () => {
      assert.equal(
        done,
        1,
        "close capturing overlay before returning to editor",
      );
      returned++;
    },
  });
  component.handleInput("\t");
  assert.equal(done, 1);
  assert.equal(returned, 1);
});

test("Focus-P0: Esc dismisses the hover but must not change editor/transcript focus", async () => {
  const { showInlineHover } = await popup();
  let component!: TestComponent;
  let returned = 0,
    done = 0;
  const ui: NativeUI = {
    notify() {},
    custom: customUI((factory) => {
      component = mountComponent(factory, () => done++);
      return Promise.resolve();
    }),
  };
  await showInlineHover({
    ui,
    snapshot: transcriptSnapshot({ screenCursor: { row: 9, col: 10 } }),
    markup: "Hover",
    geometry: {
      terminal: { rows: 35, cols: 100 },
      protectedRows: { top: 1, bottom: 5 },
    },
    onReturnToEditor: () => returned++,
  });
  component.handleInput("\x1b");
  assert.equal(done, 1);
  assert.equal(returned, 0);
});

async function hoverFixture(
  markup: string,
  options: Parameters<typeof mountComponent>[2] = {},
) {
  let component!: TestComponent;
  let layout!: () => OverlayOptions;
  const terminal = options.terminal ?? { rows: 42, columns: 120 };
  const { showInlineHover } = await popup();
  await showInlineHover({
    ui: {
      notify() {},
      custom: customUI((factory, customOptions) => {
        component = mountComponent(factory, () => {}, { ...options, terminal });
        const overlay = customOptions?.overlayOptions;
        assert.ok(typeof overlay === "function");
        layout = overlay;
        return Promise.resolve();
      }),
    },
    snapshot: transcriptSnapshot({ screenCursor: { row: 2, col: 3 } }),
    markup,
    geometry: {
      terminal: { rows: terminal.rows, cols: terminal.columns },
      protectedRows: { top: 1, bottom: 5 },
    },
  });
  const render = () => {
    const { width } = layout();
    assert.equal(typeof width, "number");
    return component.render(Number(width));
  };
  return {
    component,
    layout,
    terminal,
    render,
    text: () => render().map(stripAnsi),
  };
}

test("hover fits a one-line fenced hint without chrome or scrolling", async () => {
  const signature = "calculateTotal(): number";
  const hover = await hoverFixture("```ts\n" + signature + "\n```");
  const before = hover.text();
  assert.deepEqual(
    before.map((line) => line.trim()),
    [signature],
  );
  assert.equal(hover.layout().width, visibleWidth(signature) + 2);
  assert.equal(hover.layout().maxHeight, 1);
  assert.equal(hover.layout().row, 3);
  assert.equal(hover.layout().col, 3);
  assert.doesNotMatch(before.join("\n"), /LSP hover|Esc close|╭|╮|```/);
  hover.component.handleInput("j");
  assert.deepEqual(hover.text(), before);
  hover.component.handleInput("k");
  assert.deepEqual(hover.text(), before);
});

test("hover uses available width and wraps the full signature instead of truncating", async () => {
  const signature =
    "function calculateTotal(" +
    Array.from({ length: 8 }, (_, i) => "argument" + i + ": number").join(
      ", ",
    ) +
    "): number";
  const hover = await hoverFixture("```ts\n" + signature + "\n```");
  const before = hover.text();
  assert.ok(Number(hover.layout().width) > 68);
  assert.ok(before.length > 1);
  assert.equal(
    before.join("").replace(/\s/gu, ""),
    signature.replace(/\s/gu, ""),
  );
  assert.ok(
    before.every((line) => visibleWidth(line) <= Number(hover.layout().width)),
  );
  hover.component.handleInput("j");
  assert.deepEqual(hover.text(), before);
});

test("hover scrolls only overflow and stops on the last full viewport", async () => {
  const source = Array.from(
    { length: 40 },
    (_, i) => "line" + String(i).padStart(2, "0"),
  );
  const hover = await hoverFixture("```text\n" + source.join("\n") + "\n```", {
    terminal: { rows: 12, columns: 40 },
  });
  assert.equal(hover.layout().row, 3);
  assert.equal(hover.layout().maxHeight, 4);
  assert.deepEqual(
    hover.text().map((line) => line.trim()),
    source.slice(0, 4),
  );
  for (let i = 0; i < 100; i++) hover.component.handleInput("j");
  assert.deepEqual(
    hover.text().map((line) => line.trim()),
    source.slice(-4),
  );
  for (let i = 0; i < 100; i++) hover.component.handleInput("k");
  assert.deepEqual(
    hover.text().map((line) => line.trim()),
    source.slice(0, 4),
  );
});

test("hover wraps wide and combining characters within a narrow terminal", async () => {
  const source = "界界界界界界界界界界e\u0301e\u0301e\u0301";
  const hover = await hoverFixture("```text\n" + source + "\n```", {
    terminal: { rows: 20, columns: 16 },
  });
  const lines = hover.text();
  assert.equal(lines.map((line) => line.trim()).join(""), source);
  assert.ok(
    lines.every((line) => visibleWidth(line) <= Number(hover.layout().width)),
  );
  assert.ok(Number(hover.layout().width) <= 12);
});

test("hover remeasures on terminal resize and clamps the scroll position", async () => {
  const source = Array.from(
    { length: 20 },
    (_, i) => "line" + String(i).padStart(2, "0"),
  );
  const terminal = { rows: 12, columns: 40 };
  const hover = await hoverFixture("```text\n" + source.join("\n") + "\n```", {
    terminal,
  });
  for (let i = 0; i < 100; i++) hover.component.handleInput("j");
  terminal.rows = 40;
  assert.deepEqual(
    hover.text().map((line) => line.trim()),
    source,
  );
  const layout = hover.layout();
  assert.ok(Number(layout.row) >= 1);
  assert.ok(Number(layout.row) + Number(layout.maxHeight) <= terminal.rows - 5);
  terminal.columns = 10;
  const narrow = hover.text();
  assert.ok(narrow.every((line) => visibleWidth(line) <= 6));
  assert.ok(
    Number(hover.layout().col) + Number(hover.layout().width) <=
      terminal.columns,
  );
});

test("hover paints every padded row with Pi's background token and refreshes on invalidation", async () => {
  let background = "\x1b[48;2;1;2;3m";
  const colors: string[] = [];
  const hover = await hoverFixture(
    "```ts\nconst greeting = '" + "hello ".repeat(30) + "';\n```",
    {
      terminal: { rows: 20, columns: 40 },
      theme: {
        getBgAnsi(color) {
          colors.push(color);
          return background;
        },
        bg(color, value) {
          colors.push(color);
          return background + value + "\x1b[49m";
        },
      },
    },
  );
  const lines = hover.render();
  assert.ok(lines.length > 1);
  assert.ok(
    lines.every(
      (line) => line.startsWith(background) && line.endsWith("\x1b[49m"),
    ),
  );
  assert.ok(
    lines.every((line) => visibleWidth(line) === Number(hover.layout().width)),
  );
  assert.ok(
    colors.length > 0 && colors.every((color) => color === "customMessageBg"),
  );
  for (const line of lines) {
    for (const match of line.matchAll(/\x1b\[(?:0|49)?m/gu)) {
      if (match.index + match[0].length < line.length)
        assert.ok(
          line.slice(match.index + match[0].length).startsWith(background),
        );
    }
  }
  background = "\x1b[48;2;4;5;6m";
  hover.component.invalidate();
  assert.ok(hover.render().every((line) => line.startsWith(background)));
});

test("hover strips terminal controls from LSP content before Markdown rendering", async () => {
  const hover = await hoverFixture(
    "safe\x1b]52;c;clipboard\x07\x1b[31m text\x1b[0m",
  );
  assert.equal(hover.text().join("").trim(), "safe text");
  assert.ok(hover.render().every((line) => !line.includes("\x1b]52")));
});

test("hover keeps a short hint visible when only one row is available", async () => {
  const hover = await hoverFixture("hint", {
    terminal: { rows: 7, columns: 40 },
  });
  assert.equal(hover.layout().maxHeight, 1);
  assert.deepEqual(
    hover.text().map((line) => line.trim()),
    ["hint"],
  );
  assert.equal(hover.layout().row, 1);
});

test("hover keeps blank LSP content visible as a no-information message", async () => {
  for (const markup of [" \n\x1b[0m ", "```ts\n```"]) {
    const hover = await hoverFixture(markup);
    assert.deepEqual(
      hover.text().map((line) => line.trim()),
      ["No hover information"],
    );
  }
});
