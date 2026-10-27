import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piIntelliSense from "../../src/index.ts";
import type { IntelliSenseRegistration } from "../../src/bridge/register.ts";
import { stripAnsi } from "../../src/positions.ts";
import { createLspManager } from "../../src/runtime.ts";
import { transcriptSnapshot } from "../helpers.ts";
import { customUI, mountComponent, type CustomOptions } from "../ui-helpers.ts";

const typescript = fileURLToPath(
  new URL("../../node_modules/typescript", import.meta.url),
);

type Listener = (...args: unknown[]) => unknown;

function entryHarness(cwd: string) {
  const listeners = new Map<string, Listener>();
  let registration: IntelliSenseRegistration | undefined;
  const notices: string[] = [];
  const overlays: Array<{ options: CustomOptions; text: string }> = [];
  const pi: Pick<
    ExtensionAPI,
    "registerMarkdownTransformer" | "on" | "events"
  > = {
    registerMarkdownTransformer() {},
    on(name: string, listener: unknown) {
      assert.ok(typeof listener === "function");
      listeners.set(name, listener as Listener);
      return () => {
        listeners.delete(name);
      };
    },
    events: {
      on() {
        return () => {};
      },
      emit(name: string, payload: unknown) {
        if (name === "pi-intellisense:register:v1")
          registration = payload as IntelliSenseRegistration;
      },
    },
  };
  const ctx = {
    cwd,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => [],
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      custom: customUI(
        (factory, options) =>
          new Promise((resolve) => {
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
          }),
      ),
    },
  };
  piIntelliSense(pi as ExtensionAPI);
  return {
    notices,
    overlays,
    start: () => listeners.get("session_start")!({}, ctx),
    shutdown: () => listeners.get("session_shutdown")!(),
    hover: () => {
      assert.ok(registration);
      return registration.invoke(
        "hover",
        transcriptSnapshot({
          sourceText: "```ts\norbitBuild(1);\n```",
          renderedLines: ["```ts", "orbitBuild(1);", "```"],
          visualCursor: { row: 1, col: 2 },
          screenCursor: { row: 5, col: 2 },
        }),
      );
    },
  };
}

for (const distinct of [false, true]) {
  test(
    distinct
      ? "real TypeScript entry hover keeps a picker for genuinely distinct same-name definitions"
      : "real TypeScript entry hover canonicalizes declaration and reexport without a symbol picker",
    { timeout: 30000 },
    async () => {
      const cwd = await realpath(await mkdtemp("/tmp/pi-k-"));
      const agentDirectory = process.env.PI_CODING_AGENT_DIR;
      const h = entryHarness(cwd);
      try {
        const agent = path.join(cwd, "agent");
        await mkdir(agent);
        process.env.PI_CODING_AGENT_DIR = agent;
        await writeFile(
          path.join(agent, "pi-intellisense.json"),
          JSON.stringify({ timeoutMs: 15000 }),
        );
        await mkdir(path.join(cwd, "node_modules"));
        await symlink(
          typescript,
          path.join(cwd, "node_modules/typescript"),
          "dir",
        );
        await writeFile(
          path.join(cwd, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
            },
            include: ["*.ts"],
          }),
        );
        await writeFile(
          path.join(cwd, "origin.ts"),
          "export function orbitBuild(value: number): string { return String(value); }\n",
        );
        await writeFile(
          path.join(cwd, "reexport.ts"),
          'export { orbitBuild } from "./origin.js";\n',
        );
        await writeFile(
          path.join(cwd, "usage.ts"),
          'import { orbitBuild } from "./origin.js";\norbitBuild(1);\n',
        );
        await writeFile(
          path.join(cwd, "barrel-usage.ts"),
          'import { orbitBuild } from "./reexport.js";\norbitBuild(2);\n',
        );
        if (distinct)
          await writeFile(
            path.join(cwd, "other.ts"),
            "export function orbitBuild(value: string): number { return value.length; }\n",
          );
        const manager = createLspManager({ cwd, config: { timeoutMs: 15000 } });
        try {
          const symbols = (
            await manager.workspaceSymbols({
              query: "orbitBuild",
              languageId: "typescript",
            })
          ).filter((symbol) => symbol.name === "orbitBuild");
          assert.ok(
            symbols.length >= 2,
            "raw workspace symbols must expose duplicate candidates",
          );
          const uris = new Set(symbols.map((symbol) => symbol.location.uri));
          assert.ok(uris.has(pathToFileURL(path.join(cwd, "origin.ts")).href));
          assert.ok(
            uris.has(pathToFileURL(path.join(cwd, "reexport.ts")).href),
          );
          if (distinct)
            assert.ok(uris.has(pathToFileURL(path.join(cwd, "other.ts")).href));
        } finally {
          await manager.close();
        }
        await h.start();
        await h.hover();
        assert.deepEqual(h.notices, []);
        assert.equal(h.overlays.length, 1);
        assert.equal(h.overlays[0].options?.overlay, true);
        if (distinct) {
          assert.match(h.overlays[0].text, /Choose symbol location/);
          assert.match(h.overlays[0].text, /origin\.ts:1:/);
          assert.match(h.overlays[0].text, /other\.ts:1:/);
          assert.doesNotMatch(h.overlays[0].text, /reexport\.ts|LSP hover/);
        } else {
          assert.doesNotMatch(h.overlays[0].text, /LSP hover|Esc close/);
          assert.match(
            h.overlays[0].text,
            /function orbitBuild\(value: number\): string/,
          );
          assert.doesNotMatch(h.overlays[0].text, /Choose symbol|Snippet only/);
        }
      } finally {
        await h.shutdown();
        if (agentDirectory === undefined)
          delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = agentDirectory;
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}

for (const languageId of [undefined, "typescript"]) {
  test(
    `real TypeScript workspace lookup finds imported method cold (${languageId ?? "inferred language"})`,
    { timeout: 30000 },
    async () => {
      const cwd = await realpath(
        await mkdtemp(path.join(tmpdir(), "pi-workspace-symbol-")),
      );
      const manager = createLspManager({ cwd, config: { timeoutMs: 15000 } });
      try {
        await mkdir(path.join(cwd, "node_modules"));
        await symlink(
          typescript,
          path.join(cwd, "node_modules", "typescript"),
          "dir",
        );
        await mkdir(path.join(cwd, "src"));
        await writeFile(
          path.join(cwd, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              module: "NodeNext",
              moduleResolution: "NodeNext",
            },
            include: ["src/**/*.ts"],
          }),
        );
        const target = path.join(cwd, "src", "target.ts");
        const declaration =
          'export class Target {\n  myMethod(): string { return "real method"; }\n}\n';
        await writeFile(target, declaration);
        await writeFile(
          path.join(cwd, "src", "index.ts"),
          'import { Target } from "./target.js";\nnew Target().myMethod();\n',
        );
        const symbols = await manager.workspaceSymbols({
          query: "myMethod",
          languageId,
        });
        const symbol = symbols.find(
          (entry) =>
            entry.name === "myMethod" &&
            entry.location.uri === pathToFileURL(target).href,
        );
        assert.ok(
          symbol,
          "first cold request must return the imported declaration, not a virtual file or an empty syntax result",
        );
        assert.equal(symbol.kind, 6);
        assert.equal(symbol.location.range.start.line, 1);
        const line = (
          await readFile(fileURLToPath(symbol.location.uri), "utf8")
        ).split("\n")[1];
        assert.match(
          line.slice(
            symbol.location.range.start.character,
            symbol.location.range.end.character,
          ),
          /^myMethod\(\)/,
        );
        assert.deepEqual(
          await manager.workspaceSymbols({
            query: "noSuchWorkspaceSymbol",
            languageId,
          }),
          [],
        );
        assert.equal(await readFile(target, "utf8"), declaration);
      } finally {
        await manager.close();
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}
