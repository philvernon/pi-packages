import { promises as fsDefault } from "node:fs";
import { lspToNvimByteColumn } from "./positions.ts";
import type { NeovimRpc } from "./neovim-rpc.ts";

export interface NeovimLocation {
  path: string;
  line: number;
  character: number;
  encoding?: "utf-8" | "utf-16" | "utf-32";
}

export interface NeovimDestination {
  path: string;
  line: number;
  column: number;
}

export interface NeovimFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface NeovimCancellationOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}

export interface OpenInNeovimOptions extends NeovimCancellationOptions {
  location: NeovimLocation;
  socket: string | undefined;
  rpc: NeovimRpc;
  fs?: NeovimFileSystem;
}

const LUA = [
  "local path, line, bytecol = ...",
  "vim.cmd.edit(vim.fn.fnameescape(path))",
  "vim.api.nvim_win_set_cursor(0, {line, bytecol})",
  "return true",
].join("\n");

/** Go to source via structured Neovim Msgpack-RPC. Never shell-interpolate paths. */
export async function openInNeovim({
  location,
  socket,
  rpc,
  fs = fsDefault,
  signal,
  isCurrent = () => true,
}: OpenInNeovimOptions): Promise<NeovimDestination | undefined> {
  const current = async () =>
    !signal?.aborted && (await isCurrent()) && !signal?.aborted;
  if (!(await current()) || signal?.aborted) return;
  if (!socket || typeof socket !== "string") {
    throw new Error("No Neovim server socket configured");
  }
  if (
    !location?.path ||
    !Number.isSafeInteger(location.line) ||
    location.line < 0
  ) {
    throw new RangeError("invalid destination line");
  }
  const content = await fs.readFile(location.path, "utf8");
  if (!(await current()) || signal?.aborted) return;
  const lines = content.split(/\r?\n/u);
  const target = lines[location.line];
  if (target === undefined)
    throw new RangeError("destination line out of range");
  const column = lspToNvimByteColumn(
    target,
    location.character,
    location.encoding ?? "utf-16",
  );
  if (!(await current()) || signal?.aborted) return;
  await rpc.request("nvim_exec_lua", [
    LUA,
    [location.path, location.line + 1, column],
  ]);
  return { path: location.path, line: location.line + 1, column };
}
