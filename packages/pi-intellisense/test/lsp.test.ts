import test from "node:test";
import assert from "node:assert/strict";
import { createLspSession } from "../src/lsp.ts";
import { normalizeDocumentSymbols } from "../src/lsp/normalize.ts";
import type {
  DocumentSymbol,
  LspTransport,
  RequestOptions,
  SymbolInformation,
} from "../src/lsp/types.ts";
import { deferred, record } from "./helpers.ts";

type RpcEvent = { method: string; params: unknown; options?: RequestOptions };
function fakeTransport(respond: LspTransport["request"] = async () => null) {
  const requests: RpcEvent[] = [];
  const notifications: RpcEvent[] = [];
  return {
    requests,
    notifications,
    async request(method: string, params: unknown, options?: RequestOptions) {
      requests.push({ method, params, options });
      return respond(method, params, options);
    },
    async notify(method: string, params: unknown) {
      notifications.push({ method, params });
    },
  };
}
const rootUri = "file:///project";
const uri = "file:///project/src/a.ts";
const text = "const value = 1;\n";
const position = { line: 0, character: 6 };
const capabilities = {
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  textDocumentSync: 1,
  positionEncoding: "utf-16",
};

test("LS-01: initializes protocol then notifies initialized and opens snapshot", async () => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : null,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  assert.equal(transport.requests[0].method, "initialize");
  assert.equal(record(transport.requests[0].params).rootUri, rootUri);
  assert.deepEqual(
    record(record(record(transport.requests[0].params).capabilities).general)
      .positionEncodings,
    ["utf-16"],
  );
  assert.deepEqual(
    Object.keys(
      record(record(transport.requests[0].params).capabilities).textDocument ??
        {},
    ).sort(),
    [
      "declaration",
      "definition",
      "documentSymbol",
      "hover",
      "implementation",
      "references",
      "typeDefinition",
    ],
  );
  assert.equal(client.positionEncoding, "utf-16");
  assert.equal(transport.notifications[0].method, "initialized");
  assert.equal(transport.notifications[1].method, "textDocument/didOpen");
  assert.equal(
    record(record(transport.notifications[1].params).textDocument).uri,
    uri,
  );
  assert.equal(
    record(record(transport.notifications[1].params).textDocument).text,
    text,
  );
});

test("LS-02: hover requests exact active URI and zero-based LSP position", async () => {
  const response = {
    contents: { kind: "markdown", value: "**value**: number" },
  };
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : response,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  assert.deepEqual(await client.hover({ uri, position }), response);
  const request = transport.requests.find(
    (x) => x.method === "textDocument/hover",
  );
  assert.deepEqual(record(request?.params).position, position);
  assert.equal(record(record(request?.params).textDocument).uri, uri);
});

test("LS-03: definition and references use distinct LSP methods", async () => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : [],
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  await client.definition({ uri, position });
  await client.references({ uri, position, includeDeclaration: true });
  assert.ok(
    transport.requests.some((x) => x.method === "textDocument/definition"),
  );
  const refs = transport.requests.find(
    (x) => x.method === "textDocument/references",
  );
  assert.deepEqual(record(refs?.params).context, { includeDeclaration: true });
});

test("LS-05: unsupported LSP capability is surfaced, not synthesized by the model", async () => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities: { textDocumentSync: 1 } } : null,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  await assert.rejects(
    () => client.definition({ uri, position }),
    /unsupported|capability|definition/i,
  );
});

test("LS-06: shutdown closes document before shutdown and exit", async () => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : null,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  await client.dispose();
  assert.ok(
    transport.notifications.some((x) => x.method === "textDocument/didClose"),
  );
  assert.ok(transport.requests.some((x) => x.method === "shutdown"));
  assert.ok(transport.notifications.some((x) => x.method === "exit"));
});

test("LS-07: pending request observes cancellation", async () => {
  const transport = fakeTransport(async (method, _params, options) => {
    if (method === "initialize") return { capabilities };
    if (method !== "textDocument/hover") return null;
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  });
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await client.open({ uri, text, version: 1 });
  const ac = new AbortController();
  const request = client.hover({ uri, position, signal: ac.signal });
  ac.abort();
  await assert.rejects(request, /abort|cancel/i);
});

test("LS-08: omitted position encoding defaults to UTF-16", async () => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities: { hoverProvider: true } } : null,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  assert.equal(client.positionEncoding, "utf-16");
  await client.open({ uri, text: "😀value" });
  await client.hover({ uri, position: { line: 0, character: 2 } });
  assert.deepEqual(record(transport.requests[1].params).position, {
    line: 0,
    character: 2,
  });
});

for (const encoding of ["utf-8", "utf-32"]) {
  test(`LS-09: rejects explicit ${encoding} negotiation before opening documents`, async () => {
    const transport = fakeTransport(async () => ({
      capabilities: { ...capabilities, positionEncoding: encoding },
    }));
    const client = createLspSession({
      transport,
      rootUri,
      languageId: "typescript",
    });
    await assert.rejects(
      client.initialize(),
      /Unsupported LSP position encoding/,
    );
    await assert.rejects(client.open({ uri, text }), /not initialized/);
    assert.deepEqual(transport.notifications, []);
  });
}

test("LS-10: workspace symbols need no open document and preserve real locations", async () => {
  const symbols = [
    {
      name: "myMethod",
      kind: 6,
      location: {
        uri,
        range: { start: position, end: { line: 0, character: 14 } },
      },
    },
  ];
  const transport = fakeTransport(async (method) =>
    method === "initialize"
      ? { capabilities: { workspaceSymbolProvider: true } }
      : symbols,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
    timeoutMs: 1234,
  });
  const signal = new AbortController().signal;
  await client.initialize();
  assert.deepEqual(record(transport.requests[0].params).initializationOptions, {
    tsserver: { useSyntaxServer: "never" },
  });
  assert.deepEqual(
    record(
      record(
        record(record(transport.requests[0].params).capabilities).workspace,
      ).symbol,
    ).resolveSupport,
    { properties: ["location.range"] },
  );
  assert.deepEqual(
    await client.workspaceSymbols("myMethod", { signal }),
    symbols,
  );
  assert.deepEqual(transport.requests[1], {
    method: "workspace/symbol",
    params: { query: "myMethod" },
    options: { signal, timeoutMs: 1234 },
  });
  assert.deepEqual(
    transport.notifications.map((event) => event.method),
    ["initialized"],
  );
});

test("LS-11: workspace symbols resolve range-less locations and discard unresolved entries", async () => {
  const unresolved = {
    name: "myMethod",
    kind: 6,
    location: { uri },
    data: { id: 7 },
  };
  const resolved = {
    ...unresolved,
    location: { uri, range: { start: position, end: position } },
  };
  const transport = fakeTransport(async (method, params) => {
    if (method === "initialize")
      return {
        capabilities: { workspaceSymbolProvider: { resolveProvider: true } },
      };
    if (method === "workspace/symbol")
      return [unresolved, { ...unresolved, data: { id: 8 } }, resolved];
    if (method === "workspaceSymbol/resolve")
      return record(record(params).data).id === 7 ? resolved : params;
  });
  const client = createLspSession({ transport, rootUri, languageId: "python" });
  const signal = new AbortController().signal;
  await client.initialize();
  assert.equal(
    record(transport.requests[0].params).initializationOptions,
    undefined,
  );
  assert.deepEqual(await client.workspaceSymbols("myMethod", { signal }), [
    resolved,
    resolved,
  ]);
  const requests = transport.requests.filter(
    (event) => event.method === "workspaceSymbol/resolve",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].params, unresolved);
  assert.equal(requests[0].options?.signal, signal);
});

test("LS-12: range-less workspace symbols without resolve support are filtered, null means no matches", async () => {
  let result: unknown = [{ name: "myMethod", location: { uri } }];
  const transport = fakeTransport(async (method) =>
    method === "initialize"
      ? { capabilities: { workspaceSymbolProvider: true } }
      : result,
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  assert.deepEqual(await client.workspaceSymbols("myMethod"), []);
  result = null;
  assert.deepEqual(await client.workspaceSymbols("missing"), []);
  assert.ok(
    !transport.requests.some(
      (event) => event.method === "workspaceSymbol/resolve",
    ),
  );
});

test("LS-13: workspace lookup checks readiness and advertised capability", async () => {
  const transport = fakeTransport(async () => ({ capabilities: {} }));
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await assert.rejects(client.workspaceSymbols("myMethod"), /not initialized/);
  await client.initialize();
  await assert.rejects(
    client.workspaceSymbols("myMethod"),
    /workspaceSymbolProvider/,
  );
  assert.equal(transport.requests.length, 1);
});

test("LS-14: workspace lookup forwards cancellation to symbol resolution", async () => {
  const controller = new AbortController();
  const transport = fakeTransport(async (method, _params, options) => {
    if (method === "initialize")
      return {
        capabilities: { workspaceSymbolProvider: { resolveProvider: true } },
      };
    if (method === "workspace/symbol")
      return [{ name: "myMethod", location: { uri } }];
    if (method === "workspaceSymbol/resolve")
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
        controller.abort();
      });
  });
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  await client.initialize();
  await assert.rejects(
    client.workspaceSymbols("myMethod", { signal: controller.signal }),
    /cancelled/,
  );
});

const declarationRange = {
  start: { line: 0, character: 0 },
  end: { line: 3, character: 1 },
};
const selectionRange = {
  start: { line: 0, character: 6 },
  end: { line: 0, character: 11 },
};
const documentSymbol: DocumentSymbol = {
  name: "value",
  kind: 12,
  detail: "function value()",
  tags: [1],
  deprecated: true,
  range: declarationRange,
  selectionRange,
  children: [
    { name: "child", kind: 13, range: selectionRange, selectionRange },
  ],
};
const flatSymbol: SymbolInformation = {
  name: "value",
  kind: 12,
  tags: [1],
  deprecated: true,
  containerName: "Module",
  location: { uri, range: declarationRange },
};

test("document symbols: validated hierarchy retains exact selections, metadata and children without copying", async (t) => {
  const transport = fakeTransport(async (method) =>
    method === "initialize"
      ? { capabilities: { documentSymbolProvider: true } }
      : [documentSymbol],
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  t.after(() => client.dispose());
  await client.initialize();
  await client.open({ uri, text });
  const result = normalizeDocumentSymbols(
    await client.documentSymbols({ uri }),
    uri,
  );
  assert.deepEqual(result, [documentSymbol]);
  assert.equal(result[0], documentSymbol);
  assert.equal(result[0].children, documentSymbol.children);
  assert.deepEqual(normalizeDocumentSymbols(null, uri), []);
});

test("document symbols: flat symbols retain declaration ranges, filter files and never invent name selections", async (t) => {
  const other = {
    ...flatSymbol,
    location: { ...flatSymbol.location, uri: "file:///project/other.ts" },
  };
  const transport = fakeTransport(async (method) =>
    method === "initialize"
      ? { capabilities: { documentSymbolProvider: true } }
      : [{ ...flatSymbol, selectionRange }, other],
  );
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  t.after(() => client.dispose());
  await client.initialize();
  await client.open({ uri, text });
  const response = await client.documentSymbols({ uri });
  const normalized = normalizeDocumentSymbols(response, uri);
  assert.equal(normalized[0].selectionRange, undefined);
  assert.deepEqual(normalized, [
    {
      name: "value",
      kind: 12,
      tags: [1],
      deprecated: true,
      containerName: "Module",
      range: declarationRange,
    },
  ]);
  assert.equal(normalized[0].range, declarationRange);
  assert.equal(normalizeDocumentSymbols(response).length, 2);
  assert.deepEqual(
    normalizeDocumentSymbols(response, "file:///missing.ts"),
    [],
  );
});

const malformedSymbols: unknown[] = [
  {},
  [{ ...documentSymbol, kind: 1.5 }],
  [
    {
      ...documentSymbol,
      range: { start: declarationRange.end, end: declarationRange.start },
    },
  ],
  [
    {
      ...documentSymbol,
      selectionRange: {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 1 },
      },
    },
  ],
  [
    {
      ...documentSymbol,
      selectionRange: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      range: selectionRange,
    },
  ],
  [
    {
      ...documentSymbol,
      children: [{ ...documentSymbol, selectionRange: null }],
    },
  ],
  [{ ...documentSymbol, detail: false }],
  [{ ...documentSymbol, tags: ["deprecated"] }],
  [{ ...flatSymbol, kind: undefined }],
  [{ ...flatSymbol, kind: 1.5 }],
  [{ ...flatSymbol, deprecated: "yes" }],
  [{ ...flatSymbol, location: { uri } }],
  [documentSymbol, flatSymbol],
];
for (const [index, response] of malformedSymbols.entries()) {
  test(`document symbols: rejects malformed response at external boundary (${index})`, async (t) => {
    const transport = fakeTransport(async (method) =>
      method === "initialize"
        ? { capabilities: { documentSymbolProvider: true } }
        : response,
    );
    const client = createLspSession({
      transport,
      rootUri,
      languageId: "typescript",
    });
    t.after(() => client.dispose());
    await client.initialize();
    await client.open({ uri, text });
    await assert.rejects(
      client.documentSymbols({ uri }),
      /Malformed LSP result for textDocument\/documentSymbol/,
    );
  });
}

test("document transitions: serialize changes, skip duplicate text and keep versions monotonic", async (t) => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : null,
  );
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
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  t.after(() => client.dispose());
  await client.initialize();
  const first = client.open({ uri, text: "first", version: 7 });
  await opened.promise;
  const duplicate = client.open({ uri, text: "first", version: 100 });
  const second = client.open({ uri, text: "second", version: 1 });
  const third = client.open({ uri, text: "third", version: 10 });
  const fourth = client.open({ uri, text: "fourth", version: 2 });
  await Promise.resolve();
  assert.deepEqual(
    transport.notifications.map(({ method }) => method),
    ["initialized", "textDocument/didOpen"],
  );
  release.resolve();
  await Promise.all([first, duplicate, second, third, fourth]);
  assert.deepEqual(transport.notifications.slice(1), [
    {
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: "typescript",
          version: 7,
          text: "first",
        },
      },
    },
    ...[
      ["second", 8],
      ["third", 10],
      ["fourth", 11],
    ].map(([text, version]) => ({
      method: "textDocument/didChange",
      params: { textDocument: { uri, version }, contentChanges: [{ text }] },
    })),
  ]);
});

test("document transitions: failed notification does not advance state or poison later opens", async (t) => {
  const transport = fakeTransport(async (method) =>
    method === "initialize" ? { capabilities } : null,
  );
  const notify = transport.notify.bind(transport);
  let fail = "textDocument/didOpen";
  transport.notify = async (method, params) => {
    if (method === fail) {
      fail = "";
      throw new Error("notify failed");
    }
    await notify(method, params);
  };
  const client = createLspSession({
    transport,
    rootUri,
    languageId: "typescript",
  });
  t.after(() => client.dispose());
  await client.initialize();
  const failed = assert.rejects(client.open({ uri, text }), /notify failed/);
  const retry = client.open({ uri, text });
  await Promise.all([failed, retry]);
  fail = "textDocument/didChange";
  const changed = assert.rejects(
    client.open({ uri, text: "changed" }),
    /notify failed/,
  );
  const retried = client.open({ uri, text: "changed" });
  await Promise.all([changed, retried]);
  assert.deepEqual(transport.notifications.slice(1), [
    {
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "typescript", version: 1, text },
      },
    },
    {
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: "changed" }],
      },
    },
  ]);
});
