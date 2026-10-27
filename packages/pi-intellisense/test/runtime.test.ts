import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLspManager } from "../src/runtime.ts";
import type { TestContext } from "node:test";
import type { LspTransport, RequestOptions } from "../src/lsp/types.ts";
import type { LspTransportOptions } from "../src/runtime.ts";
import { deferred, record } from "./helpers.ts";

const cwd = process.cwd();
const file = fileURLToPath(new URL("../src/runtime.ts", import.meta.url));

type RpcEvent = { method: string; params: unknown; options?: RequestOptions };

function controlledTransport() {
  const initialization = deferred<unknown>();
  const events: string[] = [];
  let closeCount = 0;
  const transport: LspTransport = {
    async request(method) {
      events.push(method);
      if (method === "initialize") return initialization.promise;
      return null;
    },
    async notify(method) {
      events.push(method);
    },
    async close() {
      closeCount++;
      initialization.reject(new Error("transport closed"));
    },
  };
  return {
    transport,
    initialization,
    events,
    get closeCount() {
      return closeCount;
    },
  };
}

test("runtime: concurrent cold gets share initialization and wait for initialized notification", async (t) => {
  const fixture = controlledTransport();
  const notified = deferred();
  const release = deferred();
  fixture.transport.notify = async (method) => {
    fixture.events.push(method);
    if (method === "initialized") {
      notified.resolve();
      await release.promise;
    }
  };
  let starts = 0;
  const manager = createLspManager({
    cwd,
    createTransport: () => {
      starts++;
      return fixture.transport;
    },
  });
  t.after(() => manager.close());
  const first = manager.get(file, "first", { uri: "file:///first.ts" });
  const second = manager.get(file, "second", { uri: "file:///second.ts" });
  assert.equal(starts, 1);
  assert.deepEqual(fixture.events, ["initialize"]);
  fixture.initialization.resolve({ capabilities: { hoverProvider: true } });
  await notified.promise;
  assert.deepEqual(fixture.events, ["initialize", "initialized"]);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.deepEqual(fixture.events, [
    "initialize",
    "initialized",
    "textDocument/didOpen",
    "textDocument/didOpen",
  ]);
});

test("runtime: initialization failure rejects all waiters, closes transport and permits retry", async (t) => {
  const failed = controlledTransport();
  const retry = controlledTransport();
  let starts = 0;
  const manager = createLspManager({
    cwd,
    createTransport: () => (++starts === 1 ? failed : retry).transport,
  });
  t.after(() => manager.close());
  const first = manager.get(file, "first");
  const second = manager.get(file, "second");
  const rejected = Promise.all([
    assert.rejects(first, /initialize failed/),
    assert.rejects(second, /initialize failed/),
  ]);
  failed.initialization.reject(new Error("initialize failed"));
  await rejected;
  assert.equal(failed.closeCount, 1);
  assert.deepEqual(failed.events, ["initialize"]);
  const next = manager.get(file, "retry");
  retry.initialization.resolve({ capabilities: {} });
  await next;
  assert.equal(starts, 2);
  assert.deepEqual(retry.events, [
    "initialize",
    "initialized",
    "textDocument/didOpen",
  ]);
});

test("runtime: cancelling one cold waiter does not cancel shared initialization or poison cache", async (t) => {
  const fixture = controlledTransport();
  let starts = 0;
  const manager = createLspManager({
    cwd,
    createTransport: () => {
      starts++;
      return fixture.transport;
    },
  });
  t.after(() => manager.close());
  const controller = new AbortController();
  const cancelled = manager.get(file, "cancelled", {
    signal: controller.signal,
  });
  const survivor = manager.get(file, "survivor");
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(fixture.closeCount, 0);
  fixture.initialization.resolve({ capabilities: {} });
  const client = await survivor;
  assert.equal(await manager.get(file, "survivor"), client);
  assert.equal(starts, 1);
  assert.equal(
    fixture.events.filter((method) => method === "textDocument/didOpen").length,
    1,
  );
});

test("runtime: pre-cancelled get never starts a server", async () => {
  const manager = createLspManager({
    cwd,
    createTransport: () => assert.fail("must not start"),
  });
  await assert.rejects(
    manager.get(file, "", { signal: AbortSignal.abort() }),
    /cancelled/,
  );
  await manager.close();
});

test("runtime: close during initialization rejects waiters, closes transport and prevents restart", async () => {
  const fixture = controlledTransport();
  const manager = createLspManager({
    cwd,
    createTransport: () => fixture.transport,
  });
  const pending = assert.rejects(
    manager.get(file, "pending"),
    /closed|disposed/,
  );
  await manager.close();
  await pending;
  await manager.close();
  assert.equal(fixture.closeCount, 1);
  assert.deepEqual(fixture.events, ["initialize"]);
  await assert.rejects(manager.get(file, "later"), /manager closed/);
});

test("runtime: late initialize response cannot resurrect a closed session", async () => {
  const fixture = controlledTransport();
  fixture.transport.close = async () => {
    fixture.events.push("close");
  };
  const manager = createLspManager({
    cwd,
    createTransport: () => fixture.transport,
  });
  const pending = assert.rejects(manager.get(file, "pending"), /disposed/);
  await manager.close();
  fixture.initialization.resolve({ capabilities: {} });
  await pending;
  assert.deepEqual(fixture.events, ["initialize", "close"]);
});

test("runtime: concurrent cold queries work over a real stdio fixture and close cleanly", async (t) => {
  const server = fileURLToPath(
    new URL("./fixtures/lsp-server.ts", import.meta.url),
  );
  const manager = createLspManager({
    cwd,
    config: {
      timeoutMs: 2000,
      servers: { typescript: { command: process.execPath, args: [server] } },
    },
  });
  t.after(() => manager.close());
  const uri = new URL("file:///project/a.ts").href;
  const clients = await Promise.all(
    Array.from({ length: 4 }, () => manager.get(file, "😀value", { uri })),
  );
  assert.ok(clients.every((client) => client === clients[0]));
  const results = await Promise.all(
    clients.map((client) =>
      client.hover({ uri, position: { line: 0, character: 2 } }),
    ),
  );
  assert.ok(
    results.every((result) =>
      /actual mock hover.*0:2/.test(
        record(record(result).contents).value as string,
      ),
    ),
  );
  await manager.close();
  await assert.rejects(
    clients[0].hover({ uri, position: { line: 0, character: 2 } }),
    /disposed/,
  );
});

test("runtime: initialization failure after sole waiter cancels is handled and can retry", async (t) => {
  const failed = controlledTransport();
  const retry = controlledTransport();
  const cleaned = deferred();
  failed.transport.close = async () => {
    cleaned.resolve();
  };
  let starts = 0;
  const manager = createLspManager({
    cwd,
    createTransport: () => (++starts === 1 ? failed : retry).transport,
  });
  t.after(() => manager.close());
  const controller = new AbortController();
  const pending = manager.get(file, "cancelled", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  failed.initialization.reject(new Error("late initialize failure"));
  await cleaned.promise;
  const next = manager.get(file, "retry");
  retry.initialization.resolve({ capabilities: {} });
  await next;
  assert.equal(starts, 2);
  assert.deepEqual(failed.events, ["initialize"]);
});

async function workspace(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-workspace-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function symbolTransport() {
  const events: RpcEvent[] = [];
  const symbol = {
    name: "myMethod",
    kind: 6,
    location: {
      uri: "file:///real/target.ts",
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 10 },
      },
    },
  };
  return {
    events,
    symbol,
    async request(
      method: string,
      params: unknown,
      options?: RequestOptions,
    ): Promise<unknown> {
      events.push({ method, params, options });
      if (method === "initialize")
        return { capabilities: { workspaceSymbolProvider: true } };
      if (method === "workspace/symbol") return [symbol];
      return null;
    },
    async notify(method: string, params: unknown) {
      events.push({ method, params });
    },
    async close() {},
  };
}

test("runtime: cold workspace lookup selects src language and attaches one actual source without read history", async (t) => {
  const directory = await workspace(t);
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "script.py"), "root source");
  const source = path.join(directory, "src", "index.ts");
  const text = 'import { Target } from "./target";\n';
  await writeFile(source, text);
  await writeFile(
    path.join(directory, "src", "target.ts"),
    "export class Target { myMethod() {} }",
  );
  const transport = symbolTransport();
  const starts: LspTransportOptions[] = [];
  const manager = createLspManager({
    cwd: directory,
    config: {
      servers: {
        typescript: {
          command: "trusted server",
          args: ["--stdio", "; not shell"],
        },
      },
    },
    createTransport: (options) => {
      starts.push(options);
      return transport;
    },
  });
  t.after(() => manager.close());
  const signal = new AbortController().signal;
  assert.deepEqual(
    await manager.workspaceSymbols({ query: "myMethod", signal }),
    [transport.symbol],
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].command, "trusted server");
  assert.deepEqual(starts[0].args, ["--stdio", "; not shell"]);
  assert.equal(starts[0].cwd, directory);
  const opened = transport.events.filter(
    (event) => event.method === "textDocument/didOpen",
  );
  assert.equal(opened.length, 1);
  assert.deepEqual(record(opened[0].params).textDocument, {
    uri: pathToFileURL(source).href,
    languageId: "typescript",
    version: 1,
    text,
  });
  const request = transport.events.find(
    (event) => event.method === "workspace/symbol",
  );
  assert.deepEqual(request?.params, { query: "myMethod" });
  assert.equal(request?.options?.signal, signal);
  await manager.workspaceSymbols({
    query: "myMethod",
    languageId: "typescriptreact",
  });
  assert.equal(
    transport.events.filter((event) => event.method === "textDocument/didOpen")
      .length,
    1,
  );
});

test("runtime: source selection excludes dependencies, generated trees, hidden directories and symlinks", async (t) => {
  const directory = await workspace(t);
  for (const folder of [
    "node_modules",
    ".git",
    "build",
    "dist",
    "vendor",
    "target",
    "coverage",
    "out",
  ]) {
    await mkdir(path.join(directory, folder));
    await writeFile(path.join(directory, folder, "ignored.ts"), "ignored");
  }
  await symlink(
    path.join(directory, "node_modules"),
    path.join(directory, "aaa-linked"),
    "dir",
  );
  await mkdir(path.join(directory, "lib"));
  const source = path.join(directory, "lib", "actual.ts");
  await writeFile(source, "export class Actual {}");
  const transport = symbolTransport();
  const manager = createLspManager({
    cwd: directory,
    createTransport: () => transport,
  });
  t.after(() => manager.close());
  await manager.workspaceSymbols({ query: "myMethod" });
  assert.equal(
    record(
      record(
        transport.events.find(
          (event) => event.method === "textDocument/didOpen",
        )?.params,
      ).textDocument,
    ).uri,
    pathToFileURL(source).href,
  );
});

test("runtime: workspace queries share cold initialization and attachment; cancelling one waiter is isolated", async (t) => {
  const directory = await workspace(t);
  await writeFile(path.join(directory, "index.ts"), "export class Target {}");
  const transport = symbolTransport();
  const initialization = deferred<unknown>();
  const request = transport.request.bind(transport);
  transport.request = (method, ...args) =>
    method === "initialize" ? initialization.promise : request(method, ...args);
  let starts = 0;
  const manager = createLspManager({
    cwd: directory,
    createTransport: () => {
      starts++;
      return transport;
    },
  });
  t.after(() => manager.close());
  const controller = new AbortController();
  const cancelled = manager.workspaceSymbols({
    query: "cancel",
    languageId: "typescript",
    signal: controller.signal,
  });
  const survivors = Array.from({ length: 3 }, () =>
    manager.workspaceSymbols({ query: "myMethod", languageId: "typescript" }),
  );
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  initialization.resolve({ capabilities: { workspaceSymbolProvider: true } });
  assert.deepEqual(
    await Promise.all(survivors),
    Array(3).fill([transport.symbol]),
  );
  assert.equal(starts, 1);
  assert.equal(
    transport.events.filter((event) => event.method === "textDocument/didOpen")
      .length,
    1,
  );
  assert.equal(
    transport.events.filter((event) => event.method === "workspace/symbol")
      .length,
    3,
  );
});

test("runtime: workspace queries reuse an existing get without replacing its unsaved text", async (t) => {
  const transport = symbolTransport();
  const manager = createLspManager({ cwd, createTransport: () => transport });
  t.after(() => manager.close());
  const client = await manager.get(file, "unsaved source");
  await manager.workspaceSymbols({
    query: "myMethod",
    languageId: "typescript",
  });
  assert.equal(await manager.get(file, "unsaved source"), client);
  assert.equal(
    transport.events.filter((event) => event.method === "textDocument/didOpen")
      .length,
    1,
  );
  assert.ok(
    !transport.events.some(
      (event) => event.method === "textDocument/didChange",
    ),
  );
});

test("runtime: explicit non-TS languages query workspace without opening arbitrary documents", async (t) => {
  const transport = symbolTransport();
  const manager = createLspManager({ cwd, createTransport: () => transport });
  t.after(() => manager.close());
  await manager.workspaceSymbols({ query: "myMethod", languageId: "python" });
  assert.ok(
    !transport.events.some((event) => event.method === "textDocument/didOpen"),
  );
});

test("runtime: workspace lookup reports absent source and never starts when pre-cancelled or closed", async (t) => {
  const directory = await workspace(t);
  const transport = symbolTransport();
  let starts = 0;
  const manager = createLspManager({
    cwd: directory,
    createTransport: () => {
      starts++;
      return transport;
    },
  });
  await assert.rejects(
    manager.workspaceSymbols({
      query: "myMethod",
      signal: AbortSignal.abort(),
    }),
    /cancelled/,
  );
  assert.equal(starts, 0);
  await assert.rejects(
    manager.workspaceSymbols({ query: "myMethod" }),
    /No workspace source file/,
  );
  assert.equal(starts, 0);
  await assert.rejects(
    manager.workspaceSymbols({ query: "myMethod", languageId: "typescript" }),
    /No workspace source file.*attach/,
  );
  await manager.close();
  await assert.rejects(
    manager.workspaceSymbols({ query: "myMethod" }),
    /manager closed/,
  );
  assert.equal(starts, 1);
});

test("runtime: close during cold workspace initialization rejects pending lookup and never attaches", async () => {
  const fixture = controlledTransport();
  const manager = createLspManager({
    cwd,
    createTransport: () => fixture.transport,
  });
  const pending = assert.rejects(
    manager.workspaceSymbols({ query: "myMethod", languageId: "typescript" }),
    /closed|disposed/,
  );
  await manager.close();
  await pending;
  assert.equal(fixture.closeCount, 1);
  assert.deepEqual(fixture.events, ["initialize"]);
});

test("runtime: unsupported workspace provider is surfaced before attempting project attachment", async (t) => {
  const directory = await workspace(t);
  const transport = symbolTransport();
  transport.request = async () => ({ capabilities: {} });
  const manager = createLspManager({
    cwd: directory,
    createTransport: () => transport,
  });
  t.after(() => manager.close());
  await assert.rejects(
    manager.workspaceSymbols({ query: "myMethod", languageId: "typescript" }),
    /workspaceSymbolProvider/,
  );
  assert.ok(
    !transport.events.some((event) => event.method === "textDocument/didOpen"),
  );
});

for (const texts of [
  ["same", "same", "same"],
  ["first", "second", "third"],
]) {
  test(`runtime: concurrent same-URI gets serialize ${texts[0] === texts[1] ? "duplicate opens" : "text versions"}`, async (t) => {
    const transport = symbolTransport();
    const opened = deferred();
    const release = deferred();
    const notify = transport.notify.bind(transport);
    transport.notify = async (method, params) => {
      await notify(method, params);
      if (method === "textDocument/didOpen") {
        opened.resolve();
        await release.promise;
      }
    };
    const manager = createLspManager({ cwd, createTransport: () => transport });
    t.after(() => manager.close());
    const uri = pathToFileURL(file).href;
    const pending = texts.map((text) => manager.get(file, text));
    await opened.promise;
    assert.equal(
      transport.events.filter(({ method }) => method === "initialize").length,
      1,
    );
    assert.equal(
      transport.events.filter(({ method }) => method === "textDocument/didOpen")
        .length,
      1,
    );
    release.resolve();
    const clients = await Promise.all(pending);
    assert.ok(clients.every((client) => client === clients[0]));
    const transitions = transport.events.filter(({ method }) =>
      /^textDocument\/did(Open|Change)$/.test(method),
    );
    assert.deepEqual(transitions, [
      {
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "typescript",
            version: 1,
            text: texts[0],
          },
        },
      },
      ...(texts[0] === texts[1]
        ? []
        : texts.slice(1).map((text, index) => ({
            method: "textDocument/didChange",
            params: {
              textDocument: { uri, version: index + 2 },
              contentChanges: [{ text }],
            },
          }))),
    ]);
  });
}

for (const languages of [
  ["ts", "typescript", "tsx", "typescriptreact"],
  ["tsx", "typescriptreact", "ts", "typescript"],
  ["js", "javascript", "jsx", "javascriptreact"],
  ["jsx", "javascriptreact", "js", "javascript"],
]) {
  const [firstExt, firstId, secondExt, secondId] = languages;
  test(`runtime: pooled ${firstExt}/${secondExt} session opens each document with its actual language ID`, async (t) => {
    const transport = symbolTransport();
    let starts = 0;
    const manager = createLspManager({
      cwd,
      createTransport: () => {
        starts++;
        return transport;
      },
    });
    t.after(() => manager.close());
    const firstFile = path.join(cwd, `first.${firstExt}`);
    const secondFile = path.join(cwd, `second.${secondExt}`);
    const first = await manager.get(firstFile, "first");
    const second = await manager.get(secondFile, "second");
    assert.equal(first, second);
    assert.equal(starts, 1);
    assert.deepEqual(
      transport.events
        .filter(({ method }) => method === "textDocument/didOpen")
        .map(({ params }) => record(params).textDocument),
      [
        {
          uri: pathToFileURL(firstFile).href,
          text: "first",
          languageId: firstId,
          version: 1,
        },
        {
          uri: pathToFileURL(secondFile).href,
          text: "second",
          languageId: secondId,
          version: 1,
        },
      ],
    );
  });
}

for (const [extension, requestedId, actualId] of [
  ["tsx", "typescript", "typescriptreact"],
  ["ts", "typescriptreact", "typescript"],
  ["jsx", "javascript", "javascriptreact"],
  ["js", "javascriptreact", "javascript"],
]) {
  test(`runtime: cold ${requestedId} workspace attachment opens .${extension} with ${actualId}`, async (t) => {
    const directory = await workspace(t);
    const source = path.join(directory, `index.${extension}`);
    await writeFile(source, "source");
    const transport = symbolTransport();
    const manager = createLspManager({
      cwd: directory,
      createTransport: () => transport,
    });
    t.after(() => manager.close());
    await manager.workspaceSymbols({
      query: "myMethod",
      languageId: requestedId,
    });
    const opened = transport.events.find(
      ({ method }) => method === "textDocument/didOpen",
    );
    assert.deepEqual(record(opened?.params).textDocument, {
      uri: pathToFileURL(source).href,
      text: "source",
      languageId: actualId,
      version: 1,
    });
  });
}

test("runtime: explicit document language ID overrides extension without changing pooling", async (t) => {
  const transport = symbolTransport();
  let starts = 0;
  const manager = createLspManager({
    cwd,
    createTransport: () => {
      starts++;
      return transport;
    },
  });
  t.after(() => manager.close());
  const first = await manager.get(file, "first", {
    uri: "file:///virtual-one",
    languageId: "typescriptreact",
  });
  const second = await manager.get(file, "second", {
    uri: "file:///virtual-two",
    languageId: "typescript",
  });
  assert.equal(first, second);
  assert.equal(starts, 1);
  assert.deepEqual(
    transport.events
      .filter(({ method }) => method === "textDocument/didOpen")
      .map(({ params }) => record(record(params).textDocument).languageId),
    ["typescriptreact", "typescript"],
  );
});

test("runtime: cancelling a blocked open waiter leaves shared transition and unrelated documents independent", async (t) => {
  const transport = symbolTransport();
  const opened = deferred();
  const release = deferred();
  const uri = pathToFileURL(file).href;
  const notify = transport.notify.bind(transport);
  transport.notify = async (method, params) => {
    await notify(method, params);
    if (
      method === "textDocument/didOpen" &&
      record(record(params).textDocument).uri === uri
    ) {
      opened.resolve();
      await release.promise;
    }
  };
  const manager = createLspManager({ cwd, createTransport: () => transport });
  t.after(() => manager.close());
  const controller = new AbortController();
  const cancelled = manager.get(file, "shared", { signal: controller.signal });
  await opened.promise;
  const survivor = manager.get(file, "shared");
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  const unrelated = await manager.get(file, "other", {
    uri: "file:///other.ts",
  });
  assert.equal(
    transport.events.filter(({ method }) => method === "textDocument/didOpen")
      .length,
    2,
  );
  release.resolve();
  assert.equal(await survivor, unrelated);
  assert.equal(await manager.get(file, "shared"), unrelated);
  assert.ok(
    !transport.events.some(({ method }) => method === "textDocument/didChange"),
  );
});
