import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createStdioLspTransport } from "./lsp-stdio.ts";
import { createLspSession } from "./lsp.ts";
import type {
  LspSession,
  LspTransport,
  ResolvedWorkspaceSymbol,
} from "./lsp/types.ts";

export interface LanguageServerConfig {
  command: string;
  args: string[];
}

export interface LspManagerConfig {
  servers?: Record<string, LanguageServerConfig>;
  timeoutMs?: number;
}

export interface LspTransportOptions extends LanguageServerConfig {
  cwd: string;
  timeoutMs: number;
  onNotification: (method: string, params: unknown) => void;
}

export interface LspManagerOptions {
  cwd: string;
  config?: LspManagerConfig;
  onNotification?: (method: string, params: unknown) => void;
  createTransport?: (options: LspTransportOptions) => LspTransport;
}

export interface LspDocumentOptions {
  uri?: string;
  languageId?: string | null;
  signal?: AbortSignal;
}

export interface WorkspaceSymbolsOptions {
  query: string;
  languageId?: string | null;
  signal?: AbortSignal;
}

export interface LspManager {
  get(
    file: string,
    text: string,
    options?: LspDocumentOptions,
  ): Promise<LspSession>;
  workspaceSymbols(
    options: WorkspaceSymbolsOptions,
  ): Promise<ResolvedWorkspaceSymbol[]>;
  close(): Promise<void>;
}

interface ClientEntry {
  client: LspSession;
  ready: Promise<void> | null;
  hasDocument: boolean;
  attachment: Promise<void> | null;
}

const DEFAULT_SERVERS: Record<string, LanguageServerConfig> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] },
  python: { command: "basedpyright-langserver", args: ["--stdio"] },
  rust: { command: "rust-analyzer", args: [] },
  go: { command: "gopls", args: [] },
  lua: { command: "lua-language-server", args: [] },
};

export const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".lua": "lua",
};

const normalizeLanguage = (id: string): string =>
  id === "typescriptreact"
    ? "typescript"
    : id === "javascriptreact"
      ? "javascript"
      : id;

export function languageForFile(file: string): string | null {
  return LANG_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

export function createLspManager({
  cwd,
  config = {},
  onNotification = () => {},
  createTransport = createStdioLspTransport,
}: LspManagerOptions): LspManager {
  const clients = new Map<string, ClientEntry>();
  let closed = false;
  const excluded = new Set([
    "node_modules",
    "build",
    "dist",
    "vendor",
    "target",
    "coverage",
    "out",
  ]);

  async function sourceFile(
    languageId: string | null,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const queue = [path.join(cwd, "src"), cwd];
    const visited = new Set<string>();
    while (queue.length) {
      if (closed) throw new Error("LSP manager closed");
      if (signal?.aborted) throw new Error("LSP request cancelled");
      const dir = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return [];
          throw error;
        },
      );
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const directories: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || excluded.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) directories.push(file);
        else if (entry.isFile()) {
          const id = languageForFile(file);
          if (
            id &&
            (!languageId ||
              normalizeLanguage(id) === normalizeLanguage(languageId))
          )
            return file;
        }
      }
      queue.unshift(...directories);
    }
    return null;
  }

  async function session(
    languageId: string | null,
    signal?: AbortSignal,
  ): Promise<ClientEntry> {
    if (closed) throw new Error("LSP manager closed");
    if (signal?.aborted) throw new Error("LSP request cancelled");
    if (!languageId) throw new Error("No configured language server");
    const family = normalizeLanguage(languageId);
    const configServer = config.servers?.[family] ?? DEFAULT_SERVERS[family];
    if (!configServer?.command || !Array.isArray(configServer.args)) {
      throw new Error("Configure an LSP server for " + family);
    }
    const key = family + "\u0000" + cwd;
    if (!clients.has(key)) {
      const transport = createTransport({
        command: configServer.command,
        args: configServer.args,
        cwd,
        timeoutMs: config.timeoutMs ?? 5000,
        onNotification,
      });
      const client = createLspSession({
        transport,
        rootUri: pathToFileURL(cwd).href,
        languageId,
        timeoutMs: config.timeoutMs ?? 5000,
      });
      const entry: ClientEntry = {
        client,
        ready: null,
        hasDocument: false,
        attachment: null,
      };
      clients.set(key, entry);
      entry.ready = client.initialize().catch(async (error: unknown) => {
        if (clients.get(key) === entry) clients.delete(key);
        await client.dispose().catch(() => {});
        throw error;
      });
    }
    const entry = clients.get(key)!;
    await wait(entry.ready!, signal);
    return entry;
  }

  async function wait(
    ready: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error("LSP request cancelled");
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("LSP request cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        ready
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    } else await ready;
    if (closed) throw new Error("LSP manager closed");
    if (signal?.aborted) throw new Error("LSP request cancelled");
  }

  async function get(
    file: string,
    text: string,
    options: LspDocumentOptions = {},
  ): Promise<LspSession> {
    const {
      uri = pathToFileURL(file).href,
      languageId = languageForFile(file),
      signal,
    } = options;
    if (!languageId)
      throw new Error(
        "No configured language server for " + path.extname(file),
      );
    const entry = await session(languageId, signal);
    await wait(
      entry.client.open({ uri, text, languageId, version: 1 }),
      signal,
    );
    entry.hasDocument = true;
    return entry.client;
  }

  return {
    get,
    async workspaceSymbols(
      { query, languageId, signal } = {} as WorkspaceSymbolsOptions,
    ) {
      if (closed) throw new Error("LSP manager closed");
      if (signal?.aborted) throw new Error("LSP request cancelled");
      let file: string | null | undefined;
      if (!languageId) {
        file = await sourceFile(null, signal);
        if (!file)
          throw new Error(
            "No workspace source file found for language selection",
          );
        languageId = languageForFile(file);
      }
      const entry = await session(languageId ?? null, signal);
      if (
        entry.client.capabilities.workspaceSymbolProvider &&
        /^(typescript|javascript)$/.test(normalizeLanguage(languageId!)) &&
        !entry.hasDocument
      ) {
        if (!entry.attachment) {
          entry.attachment = (async () => {
            const source = file ?? (await sourceFile(languageId ?? null));
            if (!source)
              throw new Error(
                "No workspace source file found to attach " +
                  languageId +
                  " project",
              );
            const text = await readFile(source, "utf8");
            if (closed) throw new Error("LSP manager closed");
            if (!entry.hasDocument) {
              await entry.client.open({
                uri: pathToFileURL(source).href,
                text,
                languageId: languageForFile(source) ?? undefined,
                version: 1,
              });
              entry.hasDocument = true;
            }
          })().catch((error: unknown) => {
            entry.attachment = null;
            throw error;
          });
        }
        await wait(entry.attachment, signal);
      }
      return entry.client.workspaceSymbols(query, { signal });
    },
    async close() {
      closed = true;
      const all = [...clients.values()];
      clients.clear();
      await Promise.allSettled(all.map(({ client }) => client.dispose()));
    },
  };
}
