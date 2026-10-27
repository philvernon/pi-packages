import test from "node:test";
import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { connectNeovim } from "../../src/neovim-rpc.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const execFile = promisify(callback),
  root = fileURLToPath(new URL("../..", import.meta.url));
const bundle = fileURLToPath(new URL("../../../..", import.meta.url));

for (const kind of ["annotated", "read", "read-quote", "workspace"])
  test(`real Pi ${kind} transcript: K hover and gd launch without an existing editor`, async () => {
    const directory = await mkdtemp("/tmp/pi-transcript-"),
      agent = path.join(directory, "agent"),
      session = path.join(directory, "session.jsonl");
    const workspace =
      kind === "workspace" ? path.join(directory, "project") : root;
    const sourceFile = path.join(
      workspace,
      kind === "workspace" ? "source.ts" : "test/fixtures/source.ts",
    );
    const usageQuote = kind === "read-quote" || kind === "workspace";
    const server = "pi-transcript-" + process.pid + "-" + Date.now();
    const tmux = (...args: string[]) =>
      execFile("tmux", ["-L", server, ...args], { cwd: root });
    let screen = "",
      pane;
    try {
      await mkdir(agent);
      await writeFile(
        path.join(agent, "settings.json"),
        JSON.stringify({ tuiMode: "fullscreen", quietStartup: true }),
      );
      const code = await readFile(
          path.join(root, "test/fixtures/source.ts"),
          "utf8",
        ),
        timestamp = new Date().toISOString();
      if (kind === "workspace") {
        await mkdir(workspace);
        await writeFile(sourceFile, code);
        await mkdir(path.join(workspace, "node_modules"));
        await symlink(
          path.join(root, "node_modules/typescript"),
          path.join(workspace, "node_modules/typescript"),
        );
        await writeFile(
          path.join(workspace, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { target: "ES2022" },
            include: ["*.ts"],
          }),
        );
      }
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const content =
        kind === "annotated"
          ? [
              {
                type: "text",
                text:
                  '```ts source="test/fixtures/source.ts" lines="1-5"\n' +
                  code +
                  "```",
              },
            ]
          : kind === "workspace"
            ? [{ type: "text", text: "```\ngreet(café);\n```" }]
            : [
                {
                  type: "toolCall",
                  id: "read-smoke",
                  name: "read",
                  arguments: { path: "test/fixtures/source.ts" },
                },
              ];
      const entries: Array<Record<string, unknown>> = [
        {
          type: "session",
          version: 3,
          id: "transcript-smoke",
          timestamp,
          cwd: workspace,
        },
        {
          type: "message",
          id: "assistant1",
          parentId: null,
          timestamp,
          message: {
            role: "assistant",
            content,
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage,
            stopReason:
              kind === "read" || kind === "read-quote" ? "toolUse" : "stop",
            timestamp: Date.now(),
          },
        },
      ];
      if (kind === "read" || kind === "read-quote")
        entries.push({
          type: "message",
          id: "read1",
          parentId: "assistant1",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "read-smoke",
            toolName: "read",
            content: [{ type: "text", text: code }],
            isError: false,
            timestamp: Date.now(),
          },
        });
      if (kind === "read-quote")
        entries.push({
          type: "message",
          id: "assistant2",
          parentId: "read1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "```ts\ngreet(café);\n```" }],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o",
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
      await writeFile(
        session,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      const result = await execFile(
        "tmux",
        [
          "-L",
          server,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-s",
          "smoke",
          "-x",
          "120",
          "-y",
          "40",
          "-c",
          workspace,
          "env",
          "PI_CODING_AGENT_DIR=" + agent,
          "PI_OFFLINE=1",
          "PI_TELEMETRY=0",
          "PI_SKIP_VERSION_CHECK=1",
          "TMPDIR=" + directory,
          "NODE_DISABLE_COMPILE_CACHE=1",
          "NVIM=",
          "PI_INTELLISENSE_NVIM=",
          "pi",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tui-mode",
          "fullscreen",
          "--session",
          session,
          "-e",
          bundle,
        ],
        { cwd: root },
      );
      pane = result.stdout.trim();
      for (let i = 0; i < 100; i++) {
        screen = (await tmux("capture-pane", "-p", "-t", pane)).stdout;
        if (screen.includes(kind === "read" ? "read" : "greet(café)")) break;
        await delay(100);
      }
      if (kind === "read") {
        await tmux("send-keys", "-t", pane, "C-o");
        await delay(200);
        screen = (await tmux("capture-pane", "-p", "-t", pane)).stdout;
      }
      assert.match(
        screen,
        /greet\(café\)/,
        "original assistant code must render in Pi\n" + screen,
      );
      assert.ok(!screen.includes('source="'), "metadata must not be visible");
      await tmux("send-keys", "-t", pane, "Tab");
      await delay(100);
      const codeRow = screen
        .split("\n")
        .findIndex((line) =>
          line.includes(usageQuote ? "greet(café)" : "export function greet"),
        );
      assert.ok(codeRow >= 0);
      const symbolKeys = usageQuote ? ["w"] : ["w", "w", "w"];
      await tmux(
        "send-keys",
        "-t",
        pane,
        "v",
        "g",
        "g",
        ...Array(codeRow).fill("j"),
        "0",
        ...symbolKeys,
        "K",
      );
      const hoverSignature = /function greet\(name: string\): string[ \t]*$/m;
      for (let i = 0; i < 100; i++) {
        screen = (await tmux("capture-pane", "-p", "-t", pane)).stdout;
        if (hoverSignature.test(screen)) break;
        await delay(100);
      }
      assert.match(
        screen,
        hoverSignature,
        "K must render the complete inline hover signature\n" + screen,
      );
      assert.doesNotMatch(screen, /LSP hover|Esc close · Tab prompt/);
      assert.match(screen, /greet/);
      if (usageQuote) assert.match(screen, /name: string/);
      await tmux("send-keys", "-t", pane, "Escape");
      await delay(100);
      await tmux("send-keys", "-t", pane, "g", "d");
      let panes = "";
      for (let i = 0; i < 100; i++) {
        panes = (
          await tmux("list-panes", "-a", "-F", "#{pane_current_command}")
        ).stdout;
        if (panes.includes("nvim")) break;
        await delay(100);
      }
      assert.match(
        panes,
        /nvim/,
        "gd must create Neovim when none was open\n" + screen,
      );
      const editorDirectory = (await readdir(directory)).find((name) =>
        name.startsWith("pi-nvim-"),
      );
      assert.ok(editorDirectory);
      let rpc;
      for (let i = 0; i < 100; i++) {
        try {
          rpc = await connectNeovim(
            path.join(directory, editorDirectory, "nvim.sock"),
          );
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(rpc, "launched Neovim must accept RPC");
      try {
        let file: unknown;
        for (let i = 0; i < 100; i++) {
          file = await rpc.request("nvim_buf_get_name", [0]);
          if (typeof file === "string" && file.endsWith("source.ts")) break;
          await delay(50);
        }
        assert.equal(file, await realpath(sourceFile));
        assert.deepEqual(
          await rpc.request("nvim_win_get_cursor", [0]),
          [2, 16],
        );
        if (kind === "workspace") {
          await tmux("select-pane", "-t", pane);
          await tmux("send-keys", "-t", pane, "g", "r");
          let cursor: unknown;
          for (let i = 0; i < 100; i++) {
            cursor = await rpc.request("nvim_win_get_cursor", [0]);
            if (Array.isArray(cursor) && cursor[0] === 5 && cursor[1] === 0)
              break;
            await delay(50);
          }
          assert.deepEqual(
            cursor,
            [5, 0],
            "gr must open the usage, not the declaration",
          );
          const editors = (
            await tmux("list-panes", "-a", "-F", "#{pane_current_command}")
          ).stdout
            .trim()
            .split("\n")
            .filter((command) => command === "nvim");
          assert.equal(
            editors.length,
            1,
            "gr must reuse the editor opened by gd",
          );
        }
      } finally {
        rpc.close();
      }
    } finally {
      await tmux("kill-server").catch(() => {});
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
