import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createNeovimNavigator } from "../src/neovim-launcher.ts";
import type {
  NeovimNavigatorOptions,
  NavigatorExecFile,
  NavigatorFileSystem,
} from "../src/neovim-launcher.ts";
import type { NeovimLocation } from "../src/neovim.ts";
import type {
  NeovimRpcConnection,
  NeovimConnectionOptions,
} from "../src/neovim-rpc.ts";
import type { MessagePackValue } from "../src/msgpack.ts";
import { deferred } from "./helpers.ts";

const location: NeovimLocation = {
  path: "/project/é ' | $(touch nope); file.ts",
  line: 0,
  character: 3,
  encoding: "utf-16",
};

function harness(overrides: Partial<NeovimNavigatorOptions> = {}) {
  const commands: Array<{
    command: string;
    args: string[];
    options: Parameters<NavigatorExecFile>[2];
  }> = [];
  const connections: Array<{
    socket: string | undefined;
    options?: NeovimConnectionOptions;
    closed: boolean;
  }> = [];
  const requests: Array<{ method: string; args: readonly MessagePackValue[] }> =
    [];
  const removed: Array<{
    path: string;
    options: Parameters<NavigatorFileSystem["rm"]>[1];
  }> = [];
  const directories: string[] = [];
  let time = 0;
  const fs: NavigatorFileSystem = {
    async mkdtemp(prefix) {
      directories.push(prefix);
      return `${prefix}${directories.length}`;
    },
    async rm(path, options) {
      removed.push({ path, options });
    },
    async readFile(path, encoding) {
      assert.equal(path, location.path);
      assert.equal(encoding, "utf8");
      return "é🙂target\n";
    },
  };
  const options = {
    cwd: "/project/' ; $(touch nope)",
    env: { TMUX: "/tmp/tmux,1,0" },
    temporaryDirectory: "/private/tmp",
    timeoutMs: 30,
    pollIntervalMs: 10,
    now: () => time,
    async delay(ms: number) {
      time += ms;
    },
    fs,
    async execFile(
      command: string,
      args: string[],
      options: Parameters<NavigatorExecFile>[2],
    ) {
      commands.push({ command, args, options });
      return { stdout: args[0] === "split-window" ? "%42\n" : "%42 0\n" };
    },
    async connect(
      socket: string | undefined,
      options?: NeovimConnectionOptions,
    ): Promise<NeovimRpcConnection> {
      const connection = { socket, options, closed: false };
      connections.push(connection);
      return {
        async request(method: string, args: readonly MessagePackValue[] = []) {
          requests.push({ method, args });
          return true;
        },
        close() {
          connection.closed = true;
        },
      };
    },
    ...overrides,
  } satisfies NeovimNavigatorOptions;
  return {
    navigator: createNeovimNavigator(options),
    options,
    commands,
    connections,
    requests,
    removed,
    directories,
  };
}

test("TypeScript callers accept navigator defaults and cancellation options without casts", () => {
  const filename = fileURLToPath(
    new URL("./neovim-launcher-types.mts", import.meta.url),
  );
  const source = `import { createNeovimNavigator } from "../src/neovim-launcher.ts";
import { openInNeovim } from "../src/neovim.ts";
createNeovimNavigator({ cwd: "/project" });
const navigator = createNeovimNavigator({ cwd: "/project", timeoutMs: 100 });
const location = { path: "/project/file.ts", line: 0, character: 0 };
const signal = new AbortController().signal;
navigator.open(location);
navigator.open(location, { socket: "/tmp/nvim.sock" });
navigator.open(location, { socket: undefined, signal, isCurrent: () => true });
navigator.open(location, { signal, isCurrent: async () => true });
openInNeovim({ location, socket: "/tmp/nvim.sock", rpc: { request: async () => true }, signal, isCurrent: async () => true });
`;
  const options = {
    noEmit: true,
    strict: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path === filename
      ? ts.createSourceFile(path, source, languageVersion, true)
      : getSourceFile(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
    [],
  );
});

test("construction is inert; first open launches a visible split and subsequent opens reuse its socket", async () => {
  const h = harness();
  assert.equal(h.commands.length, 0);
  assert.equal(h.directories.length, 0);
  assert.equal(h.connections.length, 0);
  assert.deepEqual(await h.navigator.open(location), {
    path: location.path,
    line: 1,
    column: 6,
  });
  await h.navigator.open(location);
  assert.equal(h.commands.length, 1);
  assert.equal(h.directories.length, 1);
  assert.equal(h.connections.length, 3);
  assert.ok(
    h.connections.every(
      (c) => c.socket === "/private/tmp/pi-nvim-1/nvim.sock" && c.closed,
    ),
  );
  assert.equal(h.removed.length, 0);
});

test("explicit existing socket works outside tmux without launching or making directories", async () => {
  const h = harness({ env: {} });
  await h.navigator.open(location, { socket: "/existing/nvim.sock" });
  assert.equal(h.connections[0].socket, "/existing/nvim.sock");
  assert.equal(h.commands.length, 0);
  assert.equal(h.directories.length, 0);
  assert.equal(h.requests.length, 1);
  assert.ok(h.connections[0].closed);
});

test("missing tmux gives actionable instructions without any side effects", async () => {
  const h = harness({ env: {} });
  await assert.rejects(
    h.navigator.open(location),
    /inside tmux.*existing absolute Neovim socket/u,
  );
  assert.equal(
    h.commands.length + h.directories.length + h.connections.length,
    0,
  );
});

test("concurrent first opens share a single launch", async () => {
  const h = harness();
  await Promise.all(
    Array.from({ length: 5 }, () => h.navigator.open(location)),
  );
  assert.equal(h.commands.length, 1);
  assert.equal(h.directories.length, 1);
  assert.equal(
    h.requests.filter((r) => r.method === "nvim_exec_lua").length,
    5,
  );
  assert.ok(h.connections.every((c) => c.closed));
});

test("cwd and source metacharacters are argv and RPC data, never shell or Lua code", async () => {
  const h = harness();
  await h.navigator.open(location);
  const call = h.commands[0];
  assert.equal(call.command, "tmux");
  assert.deepEqual(call.args, [
    "split-window",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    h.options.cwd,
    "--",
    "nvim",
    "--listen",
    "/private/tmp/pi-nvim-1/nvim.sock",
  ]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, h.options.cwd);
  assert.ok(!call.args.includes(location.path));
  const navigation = h.requests.find((r) => r.method === "nvim_exec_lua");
  assert.ok(navigation);
  assert.ok(typeof navigation.args[0] === "string");
  assert.ok(!navigation.args[0]?.includes(location.path));
  assert.deepEqual(navigation.args[1], [location.path, 1, 6]);
});

test("launch failure cleans the unused directory and permits a later retry", async () => {
  const h = harness();
  let attempts = 0;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(...args) {
      if (attempts++ === 0)
        throw Object.assign(new Error("tmux missing"), { code: "ENOENT" });
      return h.options.execFile(...args);
    },
  });
  await assert.rejects(navigator.open(location), /Could not launch Neovim/u);
  assert.deepEqual(h.removed, [
    {
      path: "/private/tmp/pi-nvim-1",
      options: { recursive: true, force: true },
    },
  ]);
  await navigator.open(location);
  assert.equal(h.directories.length, 2);
});

test("readiness retries refused connections, verifies RPC, and closes the probe", async () => {
  const h = harness();
  let attempts = 0;
  const navigator = createNeovimNavigator({
    ...h.options,
    async connect(...args) {
      if (attempts++ < 2) throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  assert.equal(attempts, 4);
  assert.equal(h.requests[0].method, "nvim_get_api_info");
  assert.ok(h.connections.every((c) => c.closed));
});

test("readiness timeout retains a possibly live editor and does not launch a duplicate", async () => {
  const h = harness();
  let ready = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async connect(...args) {
      if (!ready) throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await assert.rejects(
    navigator.open(location),
    /did not become ready within 30ms/u,
  );
  assert.equal(h.removed.length, 0);
  ready = true;
  await navigator.open(location);
  assert.equal(
    h.commands.filter((c) => c.args[0] === "split-window").length,
    1,
  );
});

test("an exited pane is cleaned after readiness failure and the next open can relaunch", async () => {
  const h = harness();
  let ready = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") return { stdout: "%99 0\n%42 1\n" };
      return h.options.execFile(command, args, options);
    },
    async connect(...args) {
      if (!ready) throw new Error("editor exited");
      return h.options.connect(...args);
    },
  });
  await assert.rejects(navigator.open(location), /did not become ready/u);
  assert.equal(h.removed.length, 1);
  ready = true;
  await navigator.open(location);
  assert.equal(h.directories.length, 2);
});

test("cached editor exit relaunches and opens the destination on the same call", async () => {
  const h = harness();
  let exited = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") return { stdout: "" };
      return h.options.execFile(command, args, options);
    },
    async connect(...args) {
      if (exited && args[0] === "/private/tmp/pi-nvim-1/nvim.sock")
        throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  exited = true;
  assert.deepEqual(await navigator.open(location), {
    path: location.path,
    line: 1,
    column: 6,
  });
  assert.equal(h.commands.length, 2);
  assert.equal(h.removed.length, 1);
  assert.equal(
    h.connections.at(-1)?.socket,
    "/private/tmp/pi-nvim-2/nvim.sock",
  );
  assert.equal(
    h.requests.filter((r) => r.method === "nvim_exec_lua").length,
    2,
  );
});

test("concurrent calls share one replacement after a managed editor exits", async () => {
  const h = harness();
  let exited = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") return { stdout: "" };
      return h.options.execFile(command, args, options);
    },
    async connect(...args) {
      if (exited && args[0] === "/private/tmp/pi-nvim-1/nvim.sock")
        throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  exited = true;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => navigator.open(location)),
  );
  assert.ok(results.every((result) => result?.path === location.path));
  assert.equal(h.directories.length, 2);
  assert.equal(
    h.commands.filter((c) => c.args[0] === "split-window").length,
    2,
  );
  assert.equal(
    h.requests.filter((r) => r.method === "nvim_exec_lua").length,
    6,
  );
});

test("a managed socket connection failure with a live pane never launches another editor", async () => {
  const h = harness();
  let refused = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async connect(...args) {
      if (refused) throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  refused = true;
  await assert.rejects(navigator.open(location), /ECONNREFUSED/u);
  assert.equal(h.directories.length, 1);
  assert.equal(h.removed.length, 0);
});

test("a failed liveness query after a managed connection failure never launches another editor", async () => {
  const h = harness();
  let refused = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") throw new Error("tmux unavailable");
      return h.options.execFile(command, args, options);
    },
    async connect(...args) {
      if (refused) throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  refused = true;
  await assert.rejects(navigator.open(location), /ECONNREFUSED/u);
  assert.equal(h.directories.length, 1);
  assert.equal(h.removed.length, 0);
});

test("managed file and position errors do not probe liveness, retry navigation, or relaunch", async () => {
  const h = harness();
  await h.navigator.open(location);
  await assert.rejects(
    h.navigator.open({ ...location, character: 999 }),
    /out of range/u,
  );
  const failure = Object.assign(new Error("file does not exist"), {
    code: "ENOENT",
  });
  h.options.fs.readFile = async () => {
    throw failure;
  };
  await assert.rejects(
    h.navigator.open(location),
    (error) => error === failure,
  );
  assert.equal(h.commands.length, 1);
  assert.equal(h.directories.length, 1);
  assert.equal(
    h.requests.filter((r) => r.method === "nvim_exec_lua").length,
    1,
  );
  assert.ok(h.connections.every((c) => c.closed));
});

test("managed RPC navigation errors are propagated without replaying the open", async () => {
  const h = harness();
  let failed = false;
  const failure = new Error("Neovim RPC socket closed");
  const navigator = createNeovimNavigator({
    ...h.options,
    async connect(...args) {
      const rpc = await h.options.connect(...args);
      return {
        async request(method, params) {
          if (failed && method === "nvim_exec_lua") throw failure;
          return rpc.request(method, params);
        },
        close: rpc.close,
      };
    },
  });
  await navigator.open(location);
  failed = true;
  await assert.rejects(navigator.open(location), (error) => error === failure);
  assert.equal(h.commands.length, 1);
  assert.equal(h.directories.length, 1);
  assert.ok(h.connections.every((c) => c.closed));
});

test("replacement connection failure is propagated rather than launching in a loop", async () => {
  const h = harness();
  let failed = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") return { stdout: "" };
      return h.options.execFile(command, args, options);
    },
    async connect(...args) {
      if (
        failed &&
        (args[0]?.includes("pi-nvim-1") ||
          h.connections.at(-1)?.socket === args[0])
      )
        throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  failed = true;
  await assert.rejects(navigator.open(location), /ECONNREFUSED/u);
  assert.equal(h.directories.length, 2);
  assert.equal(h.commands.length, 2);
});

test("failed liveness query never removes the socket directory", async () => {
  const h = harness();
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(command, args, options) {
      if (args[0] === "list-panes") throw new Error("tmux unavailable");
      return h.options.execFile(command, args, options);
    },
    async connect() {
      throw new Error("not ready");
    },
  });
  await assert.rejects(navigator.open(location), /did not become ready/u);
  assert.equal(h.removed.length, 0);
});

test("timed-out launch preserves a potentially live socket and does not create a duplicate", async () => {
  const h = harness();
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile() {
      throw Object.assign(new Error("command timed out"), {
        killed: true,
        signal: "SIGTERM",
      });
    },
  });
  await assert.rejects(navigator.open(location), /Could not launch Neovim/u);
  await navigator.open(location);
  assert.equal(h.directories.length, 1);
  assert.equal(h.removed.length, 0);
});

test("failed readiness RPC probes are closed and bounded by the readiness deadline", async () => {
  const h = harness();
  let probes = 0,
    closed = 0;
  const navigator = createNeovimNavigator({
    ...h.options,
    async connect(socket, options) {
      assert.equal(socket, "/private/tmp/pi-nvim-1/nvim.sock");
      assert.ok(
        (options?.timeoutMs ?? 0) > 0 && (options?.timeoutMs ?? 0) <= 30,
      );
      probes++;
      return {
        async request() {
          throw new Error("RPC timeout");
        },
        close() {
          closed++;
        },
      };
    },
  });
  await assert.rejects(navigator.open(location), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /did not become ready/u);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "RPC timeout");
    return true;
  });
  assert.equal(probes, 3);
  assert.equal(closed, probes);
  assert.equal(h.removed.length, 0);
});

test("concurrent launch failures share one attempt and all callers receive the failure", async () => {
  const h = harness();
  let attempts = 0;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile() {
      attempts++;
      throw new Error("split failed");
    },
  });
  const results = await Promise.allSettled([
    navigator.open(location),
    navigator.open(location),
  ]);
  assert.ok(
    results.every(
      (r) =>
        r.status === "rejected" && /Could not launch/u.test(r.reason.message),
    ),
  );
  assert.equal(attempts, 1);
  assert.equal(h.directories.length, 1);
  assert.equal(h.removed.length, 1);
});

test("explicit socket failure never falls back to launching and disconnects RPC on navigation errors", async () => {
  const failure = new Error("navigation failed");
  const h = harness({
    async openInEditor() {
      throw failure;
    },
  });
  await assert.rejects(
    h.navigator.open(location, { socket: "/existing/nvim.sock" }),
    (error) => error === failure,
  );
  assert.ok(h.connections[0].closed);
  assert.equal(h.commands.length, 0);
  const refused = harness({
    async connect() {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    refused.navigator.open(location, { socket: "/existing/nvim.sock" }),
    /ECONNREFUSED/u,
  );
  assert.equal(refused.commands.length, 0);
});

for (const boundary of [
  "directory",
  "launch",
  "readiness connect",
  "readiness RPC",
  "readiness delay",
  "navigation connect",
  "file read",
]) {
  for (const cancellation of ["abort", "stale"]) {
    test(`${cancellation} during ${boundary} prevents navigation and permits a fresh open`, async () => {
      const h = harness();
      const entered = deferred(),
        release = deferred();
      let held = false,
        connections = 0;
      async function pause(at: string) {
        if (boundary !== at || held) return;
        held = true;
        entered.resolve();
        await release.promise;
      }
      const navigator = createNeovimNavigator({
        ...h.options,
        fs: {
          ...h.options.fs,
          async mkdtemp(...args) {
            const directory = await h.options.fs.mkdtemp(...args);
            await pause("directory");
            return directory;
          },
          async readFile(...args) {
            const content = await h.options.fs.readFile(...args);
            await pause("file read");
            return content;
          },
        },
        async execFile(...args) {
          const result = await h.options.execFile(...args);
          await pause("launch");
          return result;
        },
        async connect(...args) {
          const probe = connections++ === 0;
          if (probe && boundary === "readiness delay")
            throw new Error("not ready");
          const rpc = await h.options.connect(...args);
          await pause(probe ? "readiness connect" : "navigation connect");
          return {
            async request(method, params) {
              const result = await rpc.request(method, params);
              if (method === "nvim_get_api_info") await pause("readiness RPC");
              return result;
            },
            close: rpc.close,
          };
        },
        async delay(ms: number) {
          await pause("readiness delay");
          await h.options.delay(ms);
        },
      });
      const controller = new AbortController();
      let current = true;
      const pending = navigator.open(location, {
        signal: controller.signal,
        isCurrent: () => current,
      });
      await entered.promise;
      if (cancellation === "abort") controller.abort();
      else current = false;
      release.resolve();
      assert.equal(await pending, undefined);
      assert.equal(
        h.requests.filter((r) => r.method === "nvim_exec_lua").length,
        0,
      );
      assert.ok(h.connections.every((c) => c.closed));
      if (boundary === "directory") {
        assert.equal(h.commands.length, 0);
        assert.equal(h.removed.length, 1);
      } else {
        assert.equal(h.commands.length, 1);
        assert.equal(h.removed.length, 0);
      }
      assert.deepEqual(await navigator.open(location), {
        path: location.path,
        line: 1,
        column: 6,
      });
      assert.equal(h.commands.length, 1);
      assert.equal(h.directories.length, boundary === "directory" ? 2 : 1);
      assert.equal(
        h.requests.filter((r) => r.method === "nvim_exec_lua").length,
        1,
      );
      assert.ok(h.connections.every((c) => c.closed));
    });
  }
}

test("already cancelled or stale opens do not launch, connect, or read", async () => {
  const h = harness();
  h.options.fs.readFile = async () => {
    assert.fail("unexpected read");
  };
  const controller = new AbortController();
  controller.abort();
  for (const socket of [undefined, "/existing/nvim.sock"]) {
    assert.equal(
      await h.navigator.open(location, { socket, signal: controller.signal }),
      undefined,
    );
    assert.equal(
      await h.navigator.open(location, { socket, isCurrent: () => false }),
      undefined,
    );
  }
  assert.equal(
    h.commands.length + h.directories.length + h.connections.length,
    0,
  );
});

test("a current concurrent caller can launch after the first caller cancels during directory creation", async () => {
  const h = harness();
  const entered = deferred(),
    release = deferred();
  const navigator = createNeovimNavigator({
    ...h.options,
    fs: {
      ...h.options.fs,
      async mkdtemp(...args) {
        const directory = await h.options.fs.mkdtemp(...args);
        if (h.directories.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return directory;
      },
    },
  });
  const controller = new AbortController();
  const cancelled = navigator.open(location, { signal: controller.signal });
  await entered.promise;
  const fresh = [navigator.open(location), navigator.open(location)];
  controller.abort();
  release.resolve();
  assert.equal(await cancelled, undefined);
  assert.ok(
    (await Promise.all(fresh)).every(
      (result) => result?.path === location.path,
    ),
  );
  assert.equal(h.commands.length, 1);
  assert.equal(h.directories.length, 2);
});

test("cancellation during confirmed-exit recovery does not launch a replacement", async () => {
  const h = harness();
  const entered = deferred(),
    release = deferred();
  let exited = false;
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(...args) {
      if (args[1][0] === "list-panes") {
        entered.resolve();
        await release.promise;
        return { stdout: "" };
      }
      return h.options.execFile(...args);
    },
    async connect(...args) {
      if (exited && args[0]?.includes("pi-nvim-1"))
        throw new Error("ECONNREFUSED");
      return h.options.connect(...args);
    },
  });
  await navigator.open(location);
  exited = true;
  const controller = new AbortController();
  const pending = navigator.open(location, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  release.resolve();
  assert.equal(await pending, undefined);
  assert.equal(h.commands.length, 1);
  await navigator.open(location);
  assert.equal(h.commands.length, 2);
});

test("async source currentness rejects a change during cold startup and retains the editor", async () => {
  const h = harness();
  const entered = deferred(),
    release = deferred();
  let sourceHash = "original";
  const navigator = createNeovimNavigator({
    ...h.options,
    async execFile(...args) {
      const result = await h.options.execFile(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  const pending = navigator.open(location, {
    isCurrent: async () => sourceHash === "original",
  });
  await entered.promise;
  sourceHash = "modified";
  release.resolve();
  assert.equal(await pending, undefined);
  assert.equal(
    h.requests.filter((r) => r.method === "nvim_exec_lua").length,
    0,
  );
  assert.deepEqual(
    await navigator.open(location, { isCurrent: async () => true }),
    { path: location.path, line: 1, column: 6 },
  );
  assert.equal(h.commands.length, 1);
  assert.equal(h.removed.length, 0);
  assert.ok(h.connections.every((c) => c.closed));
});
