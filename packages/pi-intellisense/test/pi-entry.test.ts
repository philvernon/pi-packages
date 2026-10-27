import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import piIntelliSense from "../src/index.ts";
import { stripAnsi } from "../src/positions.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Snapshot,
  IntelliSenseRegistration,
} from "../src/bridge/register.ts";
import { customUI, mountComponent, type CustomOptions } from "./ui-helpers.ts";

type Listener = (...args: unknown[]) => unknown;
function harness(root: string) {
  const listeners = new Map<string, Listener>(),
    subscriptions = new Map<string, Set<(value: unknown) => void>>();
  const events: Array<{ name: string; payload: unknown }> = [],
    commands: string[] = [],
    transformers: Array<
      Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0]
    > = [];
  const pi: Pick<
    ExtensionAPI,
    "registerCommand" | "registerMarkdownTransformer" | "on" | "events"
  > = {
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMarkdownTransformer(
      transform: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0],
    ) {
      transformers.push(transform);
    },
    on(name: string, fn: unknown) {
      assert.ok(typeof fn === "function");
      listeners.set(name, fn as Listener);
      return () => {
        listeners.delete(name);
      };
    },
    events: {
      on(name: string, fn: (payload: unknown) => void) {
        const set = subscriptions.get(name) ?? new Set();
        set.add(fn);
        subscriptions.set(name, set);
        return () => set.delete(fn);
      },
      emit(name: string, payload: unknown) {
        events.push({ name, payload });
        for (const fn of subscriptions.get(name) ?? []) fn(payload);
      },
    },
  };
  const notices: string[] = [],
    overlays: Array<{ options: CustomOptions; text: string }> = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: (): unknown[] => [],
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      custom: customUI((factory, options) => {
        return new Promise((resolve) => {
          const component = mountComponent(factory, resolve);
          assert.equal(options?.overlay, true);
          const overlayOptions = options?.overlayOptions;
          assert.ok(typeof overlayOptions === "function");
          const layout = overlayOptions();
          assert.equal(typeof layout.width, "number");
          const width = Number(layout.width);
          const rows = component.render(width).map(stripAnsi);
          assert.ok(
            rows.every(
              (row) =>
                visibleWidth(row) === width &&
                row.startsWith(" ") &&
                row.endsWith(" "),
            ),
          );
          overlays.push({ options, text: rows.join("\n") });
          component.handleInput("\x1b");
        });
      }),
    },
  };
  piIntelliSense(pi as ExtensionAPI);
  return {
    pi,
    ctx,
    listeners,
    events,
    commands,
    transformers,
    notices,
    overlays,
    start: () => listeners.get("session_start")!({}, ctx),
    shutdown: () => listeners.get("session_shutdown")!(),
    registration: () =>
      events
        .filter((event) => event.name === "pi-intellisense:register:v1")
        .at(-1)!.payload as IntelliSenseRegistration,
  };
}
async function workspace(
  fn: (root: string) => Promise<void>,
  serverArgs: string[] = [],
) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-entry-")),
    agentDirectory = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi/agent");
    await mkdir(path.join(root, ".pi/agent"), { recursive: true });
    await writeFile(
      path.join(root, "a.ts"),
      "export const state = 12;\nconsole.log(state);\n",
    );
    await writeFile(
      path.join(root, ".pi/agent/pi-intellisense.json"),
      JSON.stringify({
        servers: {
          typescript: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL("./fixtures/lsp-server.ts", import.meta.url),
              ),
              ...serverArgs,
            ],
          },
        },
      }),
    );
    await fn(root);
  } finally {
    if (agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDirectory;
    await rm(root, { recursive: true, force: true });
  }
}
function snapshot(changes: Partial<Snapshot> = {}) {
  const sourceText =
    '```ts source="a.ts" lines="1-2"\nexport const state = 12;\nconsole.log(state);\n```';
  return {
    version: 1,
    sessionId: "test-session",
    itemSemanticKey: "message:one",
    itemKind: "message",
    transcriptRevision: "r1",
    layoutRevision: "w80",
    sourceText,
    renderedLines:
      changes.itemKind === "tool"
        ? ["  export const state = 12;", "  console.log(state);"]
        : [
            "```ts",
            "  export const state = 12;",
            "  console.log(state);",
            "```",
          ],
    renderedStartRow: 10,
    visualCursor: { row: changes.itemKind === "tool" ? 11 : 12, col: 16 },
    screenCursor: { row: 5, col: 17 },
    ...changes,
  };
}

test("extension registers source guidance and rendering hook without a viewer or model tool", () =>
  workspace(async (root) => {
    const h = harness(root);
    assert.deepEqual(h.commands, []);
    const event: { systemPromptOptions: { sections: Record<string, string> } } =
      { systemPromptOptions: { sections: { existing: "keep" } } };
    h.listeners.get("before_agent_start")!(event);
    assert.equal(event.systemPromptOptions.sections.existing, "keep");
    assert.match(
      event.systemPromptOptions.sections.intellisense_sources,
      /current workspace's language server automatically/,
    );
    assert.match(
      event.systemPromptOptions.sections.intellisense_sources,
      /no source annotations or prior file reads are required/,
    );
    const raw = snapshot().sourceText;
    assert.equal(
      h.transformers[0](raw, {
        messageType: "assistant",
        isStreaming: false,
        availableWidth: 80,
      }),
      raw.replace(' source="a.ts" lines="1-2"', ""),
    );
    assert.equal(
      h.transformers[0](raw, {
        messageType: "user",
        isStreaming: false,
        availableWidth: 80,
      }),
      raw,
    );
    await h.start();
    await h.shutdown();
  }));

test("registered native K uses annotated source through the real framed LSP adapter and inline overlay", () =>
  workspace(async (root) => {
    const h = harness(root);
    try {
      await h.start();
      await h.registration().invoke("hover", snapshot());
      assert.deepEqual(h.notices, []);
      assert.equal(h.overlays.length, 1);
      assert.equal(h.overlays[0].options?.overlay, true);
      assert.match(h.overlays[0].text, /actual mock hover/);
      assert.match(h.overlays[0].text, /1:12/);
    } finally {
      await h.shutdown();
    }
  }));

test("registered native K resolves raw read output using exact persisted tool identity", () =>
  workspace(async (root) => {
    const h = harness(root),
      code = "export const state = 12;\nconsole.log(state);";
    h.ctx.sessionManager.getBranch = () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call1",
              name: "read",
              arguments: { path: "a.ts" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "read1",
        message: {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "read",
          content: [{ type: "text", text: code }],
        },
      },
    ];
    try {
      await h.start();
      await h.registration().invoke(
        "hover",
        snapshot({
          itemKind: "tool",
          toolCallId: "call1",
          sourceText: undefined,
        }),
      );
      assert.deepEqual(h.notices, []);
      assert.match(h.overlays[0].text, /1:12/);
    } finally {
      await h.shutdown();
    }
  }));

test("stale annotated source is reported locally without querying or opening another viewer", () =>
  workspace(async (root) => {
    const h = harness(root);
    try {
      await h.start();
      await writeFile(
        path.join(root, "a.ts"),
        "changed();\nconsole.log(state);\n",
      );
      await h.registration().invoke("hover", snapshot());
      assert.equal(h.overlays.length, 0);
      assert.match(h.notices.join(" "), /no longer matches/);
    } finally {
      await h.shutdown();
    }
  }));

test("session replacement disposes registration and rejects old snapshots without duplicate listeners", () =>
  workspace(async (root) => {
    const h = harness(root);
    await h.start();
    const old = h.registration();
    await h.start();
    assert.equal(
      h.events.filter((event) => event.name === "pi-intellisense:unregister:v1")
        .length,
      1,
    );
    await assert.rejects(old.invoke("hover", snapshot()), /disposed/);
    await h.registration().invoke("hover", snapshot());
    assert.equal(h.overlays.length, 1);
    await h.shutdown();
    await h.shutdown();
    assert.equal(
      h.events.filter((event) => event.name === "pi-intellisense:unregister:v1")
        .length,
      2,
    );
  }));

test("ordinary assistant fences use workspace LSP without prior reads or virtual files", () =>
  workspace(async (root) => {
    const h = harness(root);
    try {
      await h.start();
      await h.registration().invoke(
        "hover",
        snapshot({
          sourceText: snapshot().sourceText.replace(
            ' source="a.ts" lines="1-2"',
            "",
          ),
        }),
      );
      assert.deepEqual(h.notices, []);
      assert.match(h.overlays[0].text, /actual mock hover/);
      assert.match(h.overlays[0].text, /0:13/);
      assert.doesNotMatch(h.overlays[0].text, /Snippet only/);
      await assert.rejects(
        import("node:fs/promises").then((fs) =>
          fs.stat(path.join(root, ".pi-intellisense-virtual")),
        ),
        { code: "ENOENT" },
      );
    } finally {
      await h.shutdown();
    }
  }));

test("registered references picker uses canonical workspace-relative labels", () =>
  workspace(async (root) => {
    const h = harness(root);
    try {
      await h.start();
      await h.registration().invoke("references", snapshot());
      assert.deepEqual(h.notices, []);
      assert.equal(h.overlays.length, 1);
      assert.equal(
        h.overlays[0].text
          .split("\n")
          .map((row) => row.slice(1).trimEnd())
          .join("\n"),
        "Choose references location\n> a.ts:2:13\n  c.ts:2:13",
      );
    } finally {
      await h.shutdown();
    }
  }));

test("K collapses workspace aliases to one definition; gr alone lists usages", () =>
  workspace(
    async (root) => {
      await writeFile(
        path.join(root, "b.ts"),
        'export {state} from "./a.js";\n',
      );
      await writeFile(
        path.join(root, "c.ts"),
        'import {state} from "./b.js";\nconsole.log(state);\n',
      );
      const h = harness(root);
      const point = snapshot({
        sourceText: "```ts\nconsole.log(state);\n```",
        renderedLines: ["```ts", "console.log(state);", "```"],
        visualCursor: { row: 11, col: 13 },
      });
      try {
        await h.start();
        await h.registration().invoke("hover", point);
        assert.deepEqual(h.notices, []);
        assert.equal(h.overlays.length, 1);
        assert.match(h.overlays[0].text, /actual mock hover.*0:13/);
        assert.doesNotMatch(h.overlays[0].text, /Choose/);

        await h.registration().invoke("references", point);
        assert.deepEqual(h.notices, []);
        assert.equal(h.overlays.length, 2);
        assert.match(h.overlays[1].text, /Choose references location/);
        assert.match(h.overlays[1].text, /a\.ts:2:13/);
        assert.match(h.overlays[1].text, /c\.ts:2:13/);
        assert.doesNotMatch(h.overlays[1].text, /a\.ts:1:14/);
      } finally {
        await h.shutdown();
      }
    },
    ["--workspace-aliases"],
  ));

for (const method of [
  "textDocument/documentSymbol",
  "textDocument/definition",
]) {
  test(`workspace lookup reports ${method} failures instead of hiding them as missing symbols`, () =>
    workspace(
      async (root) => {
        const h = harness(root);
        try {
          await h.start();
          await h.registration().invoke(
            "hover",
            snapshot({
              sourceText: snapshot().sourceText.replace(
                ' source="a.ts" lines="1-2"',
                "",
              ),
            }),
          );
          assert.equal(h.notices.length, 1);
          assert.match(h.notices[0], /simulated textDocument\/.* failure/);
          assert.doesNotMatch(h.notices[0], /No workspace symbol found/);
          assert.deepEqual(h.overlays, []);
        } finally {
          await h.shutdown();
        }
      },
      [`--fail-method=${method}`],
    ));
}

test("a failed alias lookup is reported even when another candidate succeeded", () =>
  workspace(
    async (root) => {
      await writeFile(
        path.join(root, "b.ts"),
        'export {state} from "./a.js";\n',
      );
      const h = harness(root);
      try {
        await h.start();
        await h.registration().invoke(
          "hover",
          snapshot({
            sourceText: snapshot().sourceText.replace(
              ' source="a.ts" lines="1-2"',
              "",
            ),
          }),
        );
        assert.equal(h.notices.length, 1);
        assert.match(
          h.notices[0],
          /simulated textDocument\/definition failure/,
        );
        assert.deepEqual(h.overlays, []);
      } finally {
        await h.shutdown();
      }
    },
    [
      "--workspace-aliases",
      "--fail-method=textDocument/definition",
      "--fail-file=b.ts",
    ],
  ));

test("unavailable workspace files are still skipped without hiding valid candidates", () =>
  workspace(
    async (root) => {
      const h = harness(root);
      try {
        await h.start();
        await h.registration().invoke(
          "hover",
          snapshot({
            sourceText: snapshot().sourceText.replace(
              ' source="a.ts" lines="1-2"',
              "",
            ),
          }),
        );
        assert.deepEqual(h.notices, []);
        assert.equal(h.overlays.length, 1);
        assert.match(h.overlays[0].text, /actual mock hover.*0:13/);
      } finally {
        await h.shutdown();
      }
    },
    ["--workspace-aliases"],
  ));

test("flat document symbols refine workspace positions without inventing a selection range", () =>
  workspace(
    async (root) => {
      const h = harness(root);
      try {
        await h.start();
        await h.registration().invoke(
          "hover",
          snapshot({
            sourceText: snapshot().sourceText.replace(
              ' source="a.ts" lines="1-2"',
              "",
            ),
          }),
        );
        assert.deepEqual(h.notices, []);
        assert.equal(h.overlays.length, 1);
        assert.match(h.overlays[0].text, /actual mock hover.*0:13/);
      } finally {
        await h.shutdown();
      }
    },
    ["--flat-symbols"],
  ));
