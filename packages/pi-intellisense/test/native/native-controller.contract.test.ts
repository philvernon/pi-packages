import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  ControllerDependencies,
  SourceRequest,
  NavigationLocation,
} from "../../src/native/native-controller.ts";
import type { SourceAnchor } from "../../src/native/transcript-source.ts";
import { transcriptSnapshot } from "../helpers.ts";
import {
  customUI,
  mountComponent,
  type CustomOptions,
  type TestComponent,
} from "../ui-helpers.ts";

async function native() {
  return import("../../src/native/native-controller.ts");
}
function fixture(overrides: Partial<ControllerDependencies> = {}) {
  const seen: {
    lsp: SourceRequest[];
    overlay: CustomOptions[];
    opened: NavigationLocation[];
    notifications: string[];
    model: string[];
    replaced: number;
  } = {
    lsp: [],
    overlay: [],
    opened: [],
    notifications: [],
    model: [],
    replaced: 0,
  };
  const snapshot = transcriptSnapshot({
    version: 1,
    sessionId: "s1",
    itemSemanticKey: "assistant:2",
    transcriptRevision: "rev:5",
    layoutRevision: "layout:8",
    visualCursor: { row: 51, col: 17 },
    screenCursor: { row: 13, col: 17 },
  });
  const anchor: SourceAnchor = {
    kind: "verified-file",
    origin: "structured-read",
    uri: "file:///project/src/total.ts",
    position: { line: 19, character: 12 },
    fileHash: "v8",
    token: "calculateTotal",
  };
  let sessionId = "s1",
    version = "rev:5";
  const ui: ControllerDependencies["ui"] & {
    setEditorComponent(): never;
    sendUserMessage(message: string): void;
  } = {
    custom: customUI(async (_factory, options) => {
      seen.overlay.push(options);
      return null;
    }),
    notify(message: string) {
      seen.notifications.push(message);
    },
    setEditorComponent() {
      seen.replaced++;
      throw new Error("transcript replacement forbidden");
    },
    sendUserMessage(message: string) {
      seen.model.push(message);
    },
  };
  const lsp: ControllerDependencies["lsp"] = {
    async query(request) {
      seen.lsp.push(request);
      if (request.kind === "hover")
        return {
          contents: { kind: "markdown", value: "calculateTotal(): number" },
        };
      return {
        uri: "file:///project/src/math.ts",
        range: {
          start: { line: 10, character: 4 },
          end: { line: 10, character: 18 },
        },
      };
    },
  };
  const neovim: ControllerDependencies["neovim"] = {
    async open(target) {
      seen.opened.push(target);
    },
  };
  const dependencies: ControllerDependencies = {
    workspaceRoot: "/project",
    ui,
    lsp,
    neovim,
    resolveSymbol: async () => anchor,
    getSession: () => ({ sessionId, transcriptRevision: version }),
    ...overrides,
  };
  return {
    ...dependencies,
    seen,
    snapshot,
    anchor,
    switchSession(id: string) {
      sessionId = id;
    },
    updateRevision(v: string) {
      version = v;
    },
  };
}

test("NT-01/02: K queries exact LSP symbol and creates ONLY an inline Pi overlay", async () => {
  const { createNativeTranscriptController } = await native();
  const f = fixture();
  const controller = createNativeTranscriptController(f);
  await controller.invoke("hover", f.snapshot);
  assert.equal(f.seen.lsp.length, 1);
  assert.deepEqual(f.seen.lsp[0].position, { line: 19, character: 12 });
  assert.equal(f.seen.lsp[0].kind, "hover");
  assert.equal(f.seen.overlay.length, 1);
  assert.equal(f.seen.overlay[0]?.overlay, true);
  assert.equal(
    f.seen.replaced,
    0,
    "native Pi transcript cannot be replaced by /intel viewer",
  );
  assert.deepEqual(f.seen.model, []);
  controller.dispose();
});

test("NT-04: gd opens real LSP definition, not the source snippet or a new code viewer", async () => {
  const { createNativeTranscriptController } = await native();
  const f = fixture();
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.deepEqual(
    f.seen.lsp.map((x) => x.kind),
    ["definition"],
  );
  assert.equal(f.seen.opened.length, 1);
  assert.deepEqual(f.seen.opened[0], {
    uri: "file:///project/src/math.ts",
    line: 10,
    character: 4,
  });
  assert.equal(f.seen.replaced, 0);
  assert.equal(f.seen.model.length, 0);
  controller.dispose();
});

test("NT-04: multiple definition targets open a transient inline picker, not first result", async () => {
  const { createNativeTranscriptController } = await native();
  const locations = [
    {
      uri: "file:///project/src/one.ts",
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 3 },
      },
    },
    {
      uri: "file:///project/src/two.ts",
      range: {
        start: { line: 3, character: 4 },
        end: { line: 3, character: 5 },
      },
    },
  ];
  const f = fixture({
    lsp: {
      async query() {
        return locations;
      },
    },
  });
  let pickerCalls = 0;
  f.snapshot.withNavigationPicker = async (run) => {
    pickerCalls++;
    return await run();
  };
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.equal(pickerCalls, 1);
  assert.equal(
    f.seen.opened.length,
    0,
    "must require choosing among multiple targets",
  );
  assert.equal(f.seen.overlay.length, 1);
  assert.equal(f.seen.overlay[0]?.overlay, true);
  controller.dispose();
});

test("NT-07: stale query result from different session/revision cannot overlay or navigate", async () => {
  const { createNativeTranscriptController } = await native();
  let release!: (value: unknown) => void;
  const f = fixture({
    lsp: {
      query: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  const controller = createNativeTranscriptController(f);
  const pending = controller.invoke("hover", f.snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  f.switchSession("s2");
  f.updateRevision("rev:6");
  release({ contents: "STALE DOCS" });
  await pending;
  assert.equal(f.seen.overlay.length, 0);
  assert.equal(f.seen.opened.length, 0);
  controller.dispose();
});

test("NT-06: unmapped symbol produces a local status without LSP, model or alternate viewer", async () => {
  const { createNativeTranscriptController } = await native();
  const f = fixture({ resolveSymbol: async () => null });
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.equal(f.seen.lsp.length, 0);
  assert.equal(f.seen.opened.length, 0);
  assert.equal(f.seen.replaced, 0);
  assert.equal(f.seen.model.length, 0);
  assert.match(
    f.seen.notifications.join(" "),
    /source|mapping|definition|symbol/i,
  );
  controller.dispose();
});
test("Focus-P0: when user tabs to editor while LSP is pending, delayed hover never opens", async () => {
  const { createNativeTranscriptController } = await native();
  let release!: (value: unknown) => void;
  let focused = true;
  const f = fixture({
    lsp: {
      query: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  const controller = createNativeTranscriptController(f);
  const pending = controller.invoke("hover", {
    ...f.snapshot,
    isCurrent: () => focused,
  });
  await new Promise((resolve) => setImmediate(resolve));
  focused = false;
  release({ contents: "outdated hover" });
  await pending;
  assert.equal(f.seen.overlay.length, 0);
  controller.dispose();
});
test("Navigation-P0: source modification after definition result cannot trigger wrong-file Neovim jump", async () => {
  const { createNativeTranscriptController } = await native();
  const f = fixture();
  const controller = createNativeTranscriptController({
    ...f,
    validateSource: async () => false,
  });
  await controller.invoke("definition", f.snapshot);
  assert.deepEqual(f.seen.opened, []);
  assert.match(f.seen.notifications.join(" "), /Source changed/i);
  controller.dispose();
});

test("source changes during hover suppress stale tooltip as well as navigation", async () => {
  const f = fixture(),
    { createNativeTranscriptController } = await native();
  const controller = createNativeTranscriptController({
    ...f,
    validateSource: async () => false,
  });
  await controller.invoke("hover", f.snapshot);
  assert.equal(f.seen.overlay.length, 0);
  assert.match(f.seen.notifications.join(" "), /Source changed/);
  controller.dispose();
});

test("disposing the production controller dismisses an already-open hover", async () => {
  const f = fixture(),
    { createNativeTranscriptController } = await native();
  let component: TestComponent | undefined,
    closed = false;
  f.ui.custom = customUI(
    (factory) =>
      new Promise((resolve) => {
        component = mountComponent(factory, (value) => {
          closed = true;
          resolve(value);
        });
      }),
  );
  const controller = createNativeTranscriptController(f);
  const pending = controller.invoke("hover", f.snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(component);
  controller.dispose();
  await pending;
  assert.equal(closed, true);
});

test("multi-result picker scrolls beyond twelve locations and displays no terminal controls from LSP URIs", async () => {
  const f = fixture(),
    { createNativeTranscriptController } = await native();
  const locations = Array.from({ length: 15 }, (_, i) => ({
    uri: `file:///project/target${i}.ts`,
    range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
  }));
  locations[0].uri = "file:///project/\x1b]52;c;unsafe\x07target0.ts";
  f.lsp.query = async () => locations;
  let screen = "";
  f.ui.custom = customUI(
    (factory) =>
      new Promise((resolve) => {
        const component = mountComponent(factory, resolve);
        assert.ok(!component.render(80).join("\n").includes("\x1b]"));
        for (let i = 0; i < 13; i++) component.handleInput("j");
        screen = component.render(80).join("\n");
        component.handleInput("\r");
      }),
  );
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.match(screen, /> .*target13\.ts/);
  assert.equal(f.seen.opened[0].uri, "file:///project/target13.ts");
  controller.dispose();
});

for (const action of ["definition", "references"] as const) {
  for (const key of ["\r", "\x1b", "\t"]) {
    test(`${action} picker shares popup background and padding with selection/cancellation ${JSON.stringify(key)}`, async () => {
      const { createNativeTranscriptController } = await native();
      const locations = [
        { uri: "file:///project/src/first.ts", line: 1, character: 2 },
        {
          uri: "file:///project/src/second%20target.ts",
          line: 3,
          character: 4,
        },
      ];
      const f = fixture();
      f.snapshot.screenCursor = { row: 2, col: 3 };
      f.lsp.query = async (request) => {
        f.seen.lsp.push(request);
        return locations.map(({ uri, line, character }) => ({
          uri,
          range: {
            start: { line, character },
            end: { line, character: character + 1 },
          },
        }));
      };
      let customCalls = 0;
      let editorFocus = 0;
      const validated: NavigationLocation[] = [];
      f.requestEditorFocus = () => editorFocus++;
      f.validateTarget = async (location) => {
        validated.push(location);
        return location;
      };
      f.ui.custom = customUI(
        (factory, options) =>
          new Promise((done) => {
            customCalls++;
            const terminal = { rows: 12, columns: 80 };
            const backgrounds: string[] = [];
            const component = mountComponent(factory, done, {
              terminal,
              theme: {
                getBgAnsi(token) {
                  assert.equal(token, "customMessageBg");
                  return "";
                },
                bg(token, text) {
                  assert.equal(token, "customMessageBg");
                  backgrounds.push(text);
                  return text;
                },
              },
            });
            assert.equal(options?.overlay, true);
            const overlayOptions = options?.overlayOptions;
            assert.ok(typeof overlayOptions === "function");
            const layout = overlayOptions();
            const width =
              Math.max(
                `Choose ${action} location`.length,
                "> src/second target.ts:4:5".length,
              ) + 2;
            assert.equal(layout.width, width);
            assert.equal(layout.row, 3);
            assert.equal(layout.maxHeight, 3);
            const rows = component.render(width);
            assert.deepEqual(backgrounds, rows);
            assert.deepEqual(
              rows.map((line) => line.slice(1).trimEnd()),
              [
                `Choose ${action} location`,
                "> src/first.ts:2:3",
                "  src/second target.ts:4:5",
              ],
            );
            assert.ok(
              rows.every(
                (line) =>
                  visibleWidth(line) === width &&
                  line.startsWith(" ") &&
                  line.endsWith(" "),
              ),
            );
            component.handleInput("j");
            terminal.rows = 7;
            terminal.columns = 24;
            const resized = overlayOptions();
            assert.equal(resized.maxHeight, 1);
            assert.ok(Number(resized.width) <= terminal.columns);
            const compact = component.render(Number(resized.width));
            assert.equal(compact.length, 1);
            assert.match(compact[0], /^ > /);
            assert.doesNotMatch(compact[0], /Choose/);
            terminal.rows = 12;
            terminal.columns = 80;
            const restored = overlayOptions();
            assert.equal(restored.width, width);
            assert.match(
              component.render(width)[2].slice(1).trimEnd(),
              /^> src\/second target\.ts:4:5$/,
            );
            component.handleInput(key);
          }),
      );
      const controller = createNativeTranscriptController(f);
      await controller.invoke(action, f.snapshot);
      assert.equal(customCalls, 1);
      assert.deepEqual(
        f.seen.lsp.map((request) => request.kind),
        [action],
      );
      assert.deepEqual(validated, key === "\r" ? [locations[1]] : []);
      assert.deepEqual(f.seen.opened, key === "\r" ? [locations[1]] : []);
      assert.equal(editorFocus, key === "\t" ? 1 : 0);
      assert.deepEqual(f.seen.notifications, []);
      controller.dispose();
    });
  }
}

for (const { rows, row, height } of [
  { rows: 12, row: 3, height: 4 },
  { rows: 7, row: 1, height: 1 },
]) {
  test(`picker uses shared below/above placement and keeps selection visible in ${height} rows`, async () => {
    const { createNativeTranscriptController } = await native();
    const locations = Array.from({ length: 8 }, (_, i) => ({
      uri: `file:///project/target${i}.ts`,
      range: {
        start: { line: i, character: 0 },
        end: { line: i, character: 1 },
      },
    }));
    const f = fixture({
      geometry: {
        terminal: { rows, cols: 80 },
        protectedRows: { top: 1, bottom: 5 },
      },
      lsp: { query: async () => locations },
    });
    f.snapshot.screenCursor = { row: 2, col: 3 };
    f.ui.custom = customUI(
      (factory, options) =>
        new Promise((done) => {
          const terminal = { rows, columns: 80 };
          const component = mountComponent(factory, done, { terminal });
          const overlayOptions = options?.overlayOptions;
          assert.equal(options?.overlay, true);
          assert.ok(typeof overlayOptions === "function");
          const layout = overlayOptions();
          assert.equal(layout.row, row);
          assert.equal(layout.col, 3);
          assert.equal(layout.maxHeight, height);
          assert.equal(typeof layout.width, "number");
          const width = Number(layout.width);
          for (let i = 0; i < locations.length; i++) {
            const rendered = component.render(width);
            assert.equal(rendered.length, height);
            assert.ok(
              rendered.every(
                (line) =>
                  visibleWidth(line) === width &&
                  line.startsWith(" ") &&
                  line.endsWith(" "),
              ),
            );
            assert.equal(
              rendered.some((line) =>
                line.includes("Choose references location"),
              ),
              height > 1,
            );
            assert.match(
              rendered.join("\n"),
              new RegExp("> .*target" + i + "\\.ts:"),
            );
            if (i < locations.length - 1) component.handleInput("j");
          }
          component.handleInput("\r");
        }),
    );
    const controller = createNativeTranscriptController(f);
    await controller.invoke("references", f.snapshot);
    assert.equal(f.seen.opened[0].uri, locations[7].uri);
    assert.deepEqual(f.seen.notifications, []);
    controller.dispose();
  });
}

for (const width of [64, 32]) {
  test(`picker decodes relative paths and retains filename/position at width ${width}`, async () => {
    const { createNativeTranscriptController } = await native();
    const locations = [
      "file:///project/src/one%20dir/shared%20%23%3F.ts",
      "file:///project/src/two%20dir/shared%20%23%3F.ts",
      `file:///project/${"long-directory/".repeat(15)}feature/target%20%23%3F.ts`,
    ].map((uri, i) => ({
      uri,
      range: {
        start: { line: i === 2 ? 122 : i, character: i === 2 ? 45 : 2 },
        end: { line: i === 2 ? 122 : i, character: i === 2 ? 46 : 3 },
      },
    }));
    const f = fixture({ lsp: { query: async () => locations } });
    let rows: string[] = [];
    f.ui.custom = customUI(
      (factory) =>
        new Promise((done) => {
          const component = mountComponent(factory, done);
          rows = component.render(width);
          component.handleInput("j");
          component.handleInput("j");
          assert.match(
            component.render(width)[3].slice(1).trimEnd(),
            /^> .*target #\?\.ts:123:46$/,
          );
          component.handleInput("\r");
        }),
    );
    const validated: NavigationLocation[] = [];
    const controller = createNativeTranscriptController({
      ...f,
      validateTarget: async (location) => {
        validated.push(location);
        return location;
      },
    });
    await controller.invoke("references", f.snapshot);
    assert.deepEqual(
      rows.slice(1, 3).map((row) => row.slice(1).trimEnd()),
      ["> src/one dir/shared #?.ts:1:3", "  src/two dir/shared #?.ts:2:3"],
    );
    assert.match(
      rows[3].slice(1).trimEnd(),
      width === 32
        ? /^  …\/target #\?\.ts:123:46$/
        : /^  …\/(?:long-directory\/)*feature\/target #\?\.ts:123:46$/,
    );
    assert.ok(
      rows.every(
        (row) =>
          visibleWidth(row) === width &&
          row.startsWith(" ") &&
          row.endsWith(" "),
      ),
    );
    assert.doesNotMatch(rows.join("\n"), /file:|\/project|%20|%23|%3F/);
    const selected = { uri: locations[2].uri, line: 122, character: 45 };
    assert.deepEqual(validated, [selected]);
    assert.deepEqual(f.seen.opened, [selected]);
    assert.deepEqual(f.seen.notifications, []);
    controller.dispose();
  });
}

test("picker safely displays malformed/non-file URIs and sanitizes decoded terminal controls", async () => {
  const { createNativeTranscriptController } = await native();
  const uris = [
    "file:///project/bad%ZZ.ts",
    "https://example.test/remote%20file.ts",
    "file:///project/%1B%5D52%3Bc%3Bunsafe%07safe%0A%09%1B%5B31m%7F%C2%9B.ts",
    "file:///elsewhere/outside.ts",
  ];
  const f = fixture({
    lsp: {
      query: async () =>
        uris.map((uri) => ({
          uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        })),
    },
  });
  let rows: string[] = [];
  f.ui.custom = customUI(
    (factory) =>
      new Promise((done) => {
        const component = mountComponent(factory, done);
        rows = component.render(64);
        component.handleInput("\r");
      }),
  );
  const validated: NavigationLocation[] = [];
  const controller = createNativeTranscriptController({
    ...f,
    validateTarget: async (location) => {
      validated.push(location);
      return null;
    },
  });
  await controller.invoke("definition", f.snapshot);
  assert.deepEqual(
    rows.slice(1).map((row) => row.slice(1).trimEnd()),
    [
      "> file:///project/bad%ZZ.ts:1:1",
      "  https://example.test/remote%20file.ts:1:1",
      "  safe.ts:1:1",
      "  ../elsewhere/outside.ts:1:1",
    ],
  );
  assert.doesNotMatch(rows.join(""), /[\x00-\x1f\x7f-\x9f]/u);
  assert.deepEqual(validated, [{ uri: uris[0], line: 0, character: 0 }]);
  assert.deepEqual(f.seen.opened, []);
  assert.deepEqual(f.seen.notifications, []);
  controller.dispose();
});

test("editor handoff retains cancellation and async source currency through delayed startup", async () => {
  const f = fixture(),
    { createNativeTranscriptController } = await native();
  let sourceCurrent = true;
  let options!: Parameters<ControllerDependencies["neovim"]["open"]>[1];
  f.neovim.open = async (_target, received) => {
    options = received;
  };
  const controller = createNativeTranscriptController({
    ...f,
    validateSource: async () => sourceCurrent,
  });
  await controller.invoke("definition", f.snapshot);
  assert.equal(await options.isCurrent(), true);
  sourceCurrent = false;
  assert.equal(await options.isCurrent(), false);
  controller.dispose();
  assert.equal(options.signal.aborted, true);
});

for (const staleIntent of [false, true]) {
  test(`editor failure after split reflow ${staleIntent ? "suppresses stale intent" : "reports current intent"}`, async () => {
    const f = fixture(),
      { createNativeTranscriptController } = await native();
    let layoutCurrent = true,
      intentCurrent = true;
    f.snapshot.isCurrent = () => layoutCurrent;
    f.snapshot.isNavigationCurrent = () => intentCurrent;
    f.neovim.open = async () => {
      layoutCurrent = false;
      if (staleIntent) intentCurrent = false;
      throw new Error("editor RPC failed");
    };
    const controller = createNativeTranscriptController(f);
    await controller.invoke("definition", f.snapshot);
    assert.deepEqual(
      f.seen.notifications,
      staleIntent ? [] : ["editor RPC failed"],
    );
    controller.dispose();
  });
}

test("committed editor navigation survives its own split reflow but not changed intent", async () => {
  const f = fixture(),
    { createNativeTranscriptController } = await native();
  let layoutCurrent = true,
    intentCurrent = true;
  f.snapshot.isCurrent = () => layoutCurrent;
  f.snapshot.isNavigationCurrent = () => intentCurrent;
  f.neovim.open = async (_target, options) => {
    layoutCurrent = false;
    assert.equal(await options.isCurrent(), true);
    intentCurrent = false;
    assert.equal(await options.isCurrent(), false);
  };
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  controller.dispose();
});

test("workspace lookup supplies real document context for ordinary transcript hover", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  const target = {
    ...f.anchor,
    kind: "verified-file",
    origin: "workspace-symbol",
    line: 19,
    character: 12,
  } satisfies SourceAnchor & NavigationLocation;
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
    languageId: "typescript",
  });
  f.findWorkspaceSymbols = async (source, { signal }) => {
    assert.deepEqual(source, {
      kind: "workspace-symbol-query",
      token: "calculateTotal",
      languageId: "typescript",
    });
    assert.equal(signal.aborted, false);
    return [target];
  };
  const controller = createNativeTranscriptController(f);
  await controller.invoke("hover", f.snapshot);
  assert.equal(f.seen.lsp[0].uri, target.uri);
  assert.deepEqual(f.seen.lsp[0].position, target.position);
  assert.equal(f.seen.lsp[0].source.origin, "workspace-symbol");
  assert.equal(f.seen.overlay.length, 1);
  controller.dispose();
});

test("gd sends textDocument/definition for a workspace-resolved symbol", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
  });
  f.findWorkspaceSymbols = async () => [
    {
      ...f.anchor,
      kind: "verified-file",
      origin: "workspace-symbol",
      line: 19,
      character: 12,
    },
  ];
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.deepEqual(
    f.seen.lsp.map((request) => request.kind),
    ["definition"],
  );
  assert.deepEqual(f.seen.lsp[0].position, f.anchor.position);
  assert.deepEqual(f.seen.opened, [
    { uri: "file:///project/src/math.ts", line: 10, character: 4 },
  ]);
  controller.dispose();
});

test("gr requests references separately from hover and definition", async () => {
  const { createNativeTranscriptController } = await native();
  const f = fixture();
  f.findWorkspaceSymbols = async () => {
    assert.fail("a known source position must not trigger workspace search");
  };
  f.lsp.query = async (request) => {
    f.seen.lsp.push(request);
    return [
      {
        uri: "file:///project/src/usage.ts",
        range: {
          start: { line: 7, character: 2 },
          end: { line: 7, character: 16 },
        },
      },
    ];
  };
  const controller = createNativeTranscriptController(f);
  await controller.invoke("references", f.snapshot);
  assert.deepEqual(
    f.seen.lsp.map((request) => request.kind),
    ["references"],
  );
  assert.deepEqual(f.seen.lsp[0].position, f.anchor.position);
  assert.deepEqual(f.seen.opened, [
    { uri: "file:///project/src/usage.ts", line: 7, character: 2 },
  ]);
  assert.deepEqual(f.seen.overlay, []);
  controller.dispose();
});

test("ambiguous workspace symbols use the existing location picker", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  const targets = [1, 2].map(
    (line) =>
      ({
        ...f.anchor,
        kind: "verified-file",
        origin: "workspace-symbol",
        uri: `file:///project/src/target${line}.ts`,
        position: { line, character: 3 },
        line,
        character: 3,
      }) satisfies SourceAnchor & NavigationLocation,
  );
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
  });
  f.findWorkspaceSymbols = async () => targets;
  f.lsp.query = async (request) => {
    f.seen.lsp.push(request);
    return {
      uri: request.uri,
      range: { start: request.position, end: request.position },
    };
  };
  let wrapped = 0;
  f.snapshot.withNavigationPicker = async (run) => {
    wrapped++;
    return run();
  };
  f.ui.custom = customUI(
    (factory) =>
      new Promise((done) => {
        const component = mountComponent(factory, done);
        assert.deepEqual(
          component
            .render(64)
            .slice(1)
            .map((row) => row.slice(1).trimEnd()),
          ["> src/target1.ts:2:4", "  src/target2.ts:3:4"],
        );
        component.handleInput("j");
        component.handleInput("\r");
      }),
  );
  const controller = createNativeTranscriptController(f);
  await controller.invoke("definition", f.snapshot);
  assert.equal(wrapped, 1);
  assert.deepEqual(f.seen.opened, [
    { uri: targets[1].uri, line: 2, character: 3 },
  ]);
  controller.dispose();
});

test("a workspace miss is reported without querying an isolated snippet", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
  });
  f.findWorkspaceSymbols = async () => [];
  const controller = createNativeTranscriptController(f);
  await controller.invoke("hover", f.snapshot);
  assert.match(
    f.seen.notifications[0],
    /No workspace symbol found for calculateTotal/,
  );
  assert.deepEqual(f.seen.lsp, []);
  assert.deepEqual(f.seen.overlay, []);
  controller.dispose();
});

test("workspace lookup cannot navigate after transcript focus changes", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  let release!: (
    value: Awaited<
      ReturnType<NonNullable<ControllerDependencies["findWorkspaceSymbols"]>>
    >,
  ) => void;
  let focused = true;
  f.snapshot.isCurrent = () => focused;
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
  });
  f.findWorkspaceSymbols = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const controller = createNativeTranscriptController(f),
    pending = controller.invoke("definition", f.snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  focused = false;
  release([
    {
      ...f.anchor,
      kind: "verified-file",
      origin: "workspace-symbol",
      line: f.anchor.position.line,
      character: f.anchor.position.character,
    },
  ]);
  await pending;
  assert.deepEqual(f.seen.opened, []);
  assert.deepEqual(f.seen.lsp, []);
  controller.dispose();
});

test("a workspace query without a lookup never reaches document LSP", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
    languageId: "typescript",
  });
  const controller = createNativeTranscriptController(f);
  await controller.invoke("hover", f.snapshot);
  assert.deepEqual(f.seen.lsp, []);
  assert.deepEqual(f.seen.overlay, []);
  assert.deepEqual(f.seen.opened, []);
  controller.dispose();
});

test("disposing during workspace lookup aborts it and suppresses late results", async () => {
  const { createNativeTranscriptController } = await native(),
    f = fixture();
  let release!: (value: (SourceAnchor & NavigationLocation)[]) => void;
  let signal!: AbortSignal;
  f.resolveSymbol = async () => ({
    kind: "workspace-symbol-query",
    token: "calculateTotal",
  });
  f.findWorkspaceSymbols = (_source, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const controller = createNativeTranscriptController(f);
  const pending = controller.invoke("definition", f.snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  assert.equal(signal.aborted, true);
  release([{ ...f.anchor, line: 19, character: 12 }]);
  await pending;
  assert.deepEqual(f.seen.lsp, []);
  assert.deepEqual(f.seen.overlay, []);
  assert.deepEqual(f.seen.opened, []);
});
