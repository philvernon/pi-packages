import type {
  LspCapabilities,
  LspDocumentRequest,
  LspOperation,
  LspPosition,
  LspResultMap,
  LspSession,
  Request,
  LspTransport,
  ResolvedWorkspaceSymbol,
} from "./lsp/types.ts";
import {
  isLspCapabilities,
  isLspResult,
  isRecord,
  isResolvedWorkspaceSymbol,
  isWorkspaceSymbol,
} from "./lsp/normalize.ts";

export interface LspSessionOptions {
  transport: LspTransport;
  rootUri?: string | null;
  languageId: string;
  timeoutMs?: number;
}

export function createLspSession({
  transport,
  rootUri,
  languageId,
  timeoutMs = 5000,
}: LspSessionOptions): LspSession {
  let initialized = false;
  let disposed = false;
  let capabilities: LspCapabilities = {};
  const docs = new Map<
    string,
    { text?: string; version: number; pending: Promise<void> }
  >();

  function requireReady(): void {
    if (!initialized || disposed) {
      throw new Error("LSP session not initialized or disposed");
    }
  }

  async function initialize(): Promise<void> {
    if (disposed) throw new Error("LSP session disposed");
    if (initialized) return;
    const params: {
      processId: number;
      rootUri: string | null | undefined;
      rootPath: null;
      workspaceFolders: { uri: string; name: string }[] | null;
      clientInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
      initializationOptions?: { tsserver: { useSyntaxServer: "never" } };
    } = {
      processId: process.pid,
      rootUri,
      rootPath: null,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: "workspace" }] : null,
      clientInfo: { name: "pi-intellisense", version: "0.1.0" },
      capabilities: {
        workspace: {
          symbol: { resolveSupport: { properties: ["location.range"] } },
        },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          declaration: { linkSupport: true },
          implementation: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    };
    // Dynamic syntax routing can return incomplete navto results while the project loads.
    if (/^(typescript|javascript)/.test(languageId)) {
      params.initializationOptions = { tsserver: { useSyntaxServer: "never" } };
    }
    const info = await transport.request("initialize", params);
    if (disposed) throw new Error("LSP session disposed");
    if (info != null && !isRecord(info))
      throw new Error("Malformed LSP initialize response");
    const serverCapabilities = info?.capabilities ?? {};
    if (!isLspCapabilities(serverCapabilities))
      throw new Error("Malformed LSP capabilities");
    capabilities = serverCapabilities;
    if (
      capabilities.positionEncoding !== undefined &&
      capabilities.positionEncoding !== "utf-16"
    ) {
      throw new Error(
        "Unsupported LSP position encoding: " +
          capabilities.positionEncoding +
          " (expected utf-16)",
      );
    }
    await transport.notify("initialized", {});
    if (disposed) throw new Error("LSP session disposed");
    initialized = true;
  }

  async function open({
    uri,
    text,
    languageId: documentLanguageId = languageId,
    version = 1,
  }: {
    uri: string;
    text: string;
    languageId?: string;
    version?: number;
  }): Promise<void> {
    requireReady();
    let current = docs.get(uri);
    if (!current) {
      current = { version: 0, pending: Promise.resolve() };
      docs.set(uri, current);
    }
    const document = current;
    const transition = document.pending.then(async () => {
      requireReady();
      if (document.text === text) return;
      const next =
        document.text === undefined
          ? version
          : Math.max(version, document.version + 1);
      if (document.text !== undefined) {
        await transport.notify("textDocument/didChange", {
          textDocument: { uri, version: next },
          contentChanges: [{ text }],
        });
      } else {
        await transport.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: documentLanguageId,
            version: next,
            text,
          },
        });
      }
      document.text = text;
      document.version = next;
    });
    document.pending = transition.catch(() => {});
    await transition;
  }

  function request(
    method: string,
    capability: string,
    { uri, position, signal, includeDeclaration = false }: LspDocumentRequest,
  ): Promise<unknown> {
    requireReady();
    if (!capabilities[capability])
      throw new Error("Unsupported LSP capability: " + capability);
    if (docs.get(uri)?.text === undefined)
      throw new Error("LSP document must be opened before requesting");
    const params: {
      textDocument: { uri: string };
      position?: LspPosition;
      context?: { includeDeclaration: boolean };
    } = { textDocument: { uri }, ...(position ? { position } : {}) };
    if (method === "textDocument/references")
      params.context = { includeDeclaration };
    return transport.request(method, params, { signal, timeoutMs });
  }

  const methodMap = {
    hover: ["textDocument/hover", "hoverProvider"],
    definition: ["textDocument/definition", "definitionProvider"],
    declaration: ["textDocument/declaration", "declarationProvider"],
    implementation: ["textDocument/implementation", "implementationProvider"],
    typeDefinition: ["textDocument/typeDefinition", "typeDefinitionProvider"],
    references: ["textDocument/references", "referencesProvider"],
    documentSymbols: ["textDocument/documentSymbol", "documentSymbolProvider"],
  } as const satisfies Record<LspOperation, readonly [string, string]>;

  const client: LspSession = {
    initialize,
    open,
    async workspaceSymbols(query, { signal } = {}) {
      requireReady();
      if (!capabilities.workspaceSymbolProvider) {
        throw new Error("Unsupported LSP capability: workspaceSymbolProvider");
      }
      const symbols = await transport.request(
        "workspace/symbol",
        { query },
        { signal, timeoutMs },
      );
      if (symbols != null && !Array.isArray(symbols))
        throw new Error("Malformed LSP workspace symbols");
      const results: ResolvedWorkspaceSymbol[] = [];
      const candidates: unknown[] = symbols ?? [];
      for (let symbol of candidates) {
        if (!isWorkspaceSymbol(symbol)) continue;
        if (
          !symbol.location?.range &&
          typeof capabilities.workspaceSymbolProvider === "object" &&
          capabilities.workspaceSymbolProvider.resolveProvider
        ) {
          symbol = await transport.request("workspaceSymbol/resolve", symbol, {
            signal,
            timeoutMs,
          });
        }
        if (isResolvedWorkspaceSymbol(symbol)) results.push(symbol);
      }
      return results;
    },
    get capabilities() {
      return capabilities;
    },
    get positionEncoding() {
      return capabilities.positionEncoding ?? "utf-16";
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (!initialized) return;
        await Promise.all([...docs.values()].map((doc) => doc.pending));
        for (const [uri, doc] of docs) {
          if (doc.text === undefined) continue;
          await transport
            .notify("textDocument/didClose", { textDocument: { uri } })
            .catch(() => {});
        }
        docs.clear();
        await transport.request("shutdown", null).catch(() => {});
        await transport.notify("exit", null).catch(() => {});
      } finally {
        await transport.close?.();
      }
    },
    async query<Kind extends LspOperation>({
      kind,
      uri,
      position,
      signal,
      includeDeclaration,
    }: Request<Kind>): Promise<LspResultMap[Kind]> {
      const method = methodMap[kind];
      if (!method) throw new Error("Unsupported LSP operation: " + kind);
      const result = await request(method[0], method[1], {
        uri,
        position,
        signal,
        includeDeclaration,
      });
      if (!isLspResult(kind, result))
        throw new Error("Malformed LSP result for " + method[0]);
      return result;
    },
    hover: (args) => client.query({ ...args, kind: "hover" }),
    definition: (args) => client.query({ ...args, kind: "definition" }),
    declaration: (args) => client.query({ ...args, kind: "declaration" }),
    implementation: (args) => client.query({ ...args, kind: "implementation" }),
    typeDefinition: (args) => client.query({ ...args, kind: "typeDefinition" }),
    references: (args) => client.query({ ...args, kind: "references" }),
    documentSymbols: (args) =>
      client.query({ ...args, kind: "documentSymbols" }),
  };
  return client;
}
