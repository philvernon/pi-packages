import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promises as fsDefault } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delayDefault } from "node:timers/promises";
import { openInNeovim } from "./neovim.ts";
import type {
  NeovimCancellationOptions,
  NeovimDestination,
  NeovimFileSystem,
  NeovimLocation,
} from "./neovim.ts";
import { connectNeovim } from "./neovim-rpc.ts";
import type { NeovimRpcConnection } from "./neovim-rpc.ts";

export interface NavigatorFileSystem extends NeovimFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export type NavigatorExecFile = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string }>;

export interface NeovimNavigatorOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  execFile?: NavigatorExecFile;
  fs?: NavigatorFileSystem;
  connect?: typeof connectNeovim;
  openInEditor?: typeof openInNeovim;
  temporaryDirectory?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface NeovimNavigatorOpenOptions extends NeovimCancellationOptions {
  socket?: string;
}

export interface NeovimNavigator {
  open(
    location: NeovimLocation,
    options?: NeovimNavigatorOpenOptions,
  ): Promise<NeovimDestination | undefined>;
}

interface ManagedEditor {
  directory: string;
  socket: string;
  pane?: string;
}

type IsCurrent = () => boolean | Promise<boolean>;

export function createNeovimNavigator({
  cwd,
  env = process.env,
  execFile = promisify(execFileCallback),
  fs = fsDefault,
  connect = connectNeovim,
  openInEditor = openInNeovim,
  temporaryDirectory = tmpdir(),
  timeoutMs = 5000,
  pollIntervalMs = 50,
  delay = delayDefault,
  now = Date.now,
}: NeovimNavigatorOptions): NeovimNavigator {
  let editor: ManagedEditor | undefined;
  let launching: Promise<ManagedEditor | undefined> | undefined;

  async function discardIfExited(
    candidate: ManagedEditor,
  ): Promise<true | undefined> {
    if (!candidate.pane) return;
    let stdout;
    try {
      ({ stdout } = await execFile(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"],
        { cwd, env, shell: false, timeout: timeoutMs },
      ));
    } catch {
      // A failed tmux query is not proof that the user's editor has exited.
      return;
    }
    const alive = stdout
      .trim()
      .split(/\r?\n/u)
      .some((line) => line === `${candidate.pane} 0`);
    if (alive) return;
    await fs.rm(candidate.directory, { recursive: true, force: true });
    if (editor === candidate) editor = undefined;
    return true;
  }

  async function waitUntilReady(candidate: ManagedEditor): Promise<void> {
    const deadline = now() + timeoutMs;
    let failure: unknown;
    while (now() < deadline) {
      let rpc: NeovimRpcConnection | undefined;
      try {
        rpc = await connect(candidate.socket, {
          timeoutMs: Math.max(1, deadline - now()),
        });
        await rpc.request("nvim_get_api_info", []);
        return;
      } catch (error) {
        failure = error;
      } finally {
        rpc?.close();
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }
    throw new Error(
      `Neovim did not become ready within ${timeoutMs}ms; check the tmux split and nvim installation`,
      { cause: failure },
    );
  }

  async function launch(
    isCurrent: IsCurrent,
  ): Promise<ManagedEditor | undefined> {
    const directory = await fs.mkdtemp(join(temporaryDirectory, "pi-nvim-"));
    if (!(await isCurrent())) {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    }
    const socket = join(directory, "nvim.sock");
    let result;
    try {
      result = await execFile(
        "tmux",
        [
          "split-window",
          "-P",
          "-F",
          "#{pane_id}",
          "-c",
          cwd,
          "--",
          "nvim",
          "--listen",
          socket,
        ],
        { cwd, env, shell: false, timeout: timeoutMs },
      );
    } catch (error) {
      // A timed-out tmux client may already have created a live editor.
      if (
        error &&
        typeof error === "object" &&
        (("killed" in error && error.killed) ||
          ("signal" in error && error.signal))
      ) {
        editor = { directory, socket };
      } else {
        await fs.rm(directory, { recursive: true, force: true });
      }
      throw new Error(
        "Could not launch Neovim in a tmux split; check tmux and nvim are installed and the session is active",
        { cause: error },
      );
    }
    const pane = result.stdout.trim();
    const candidate = {
      directory,
      socket,
      pane: /^%\d+$/u.test(pane) ? pane : undefined,
    };
    editor = candidate;
    try {
      await waitUntilReady(candidate);
    } catch (error) {
      await discardIfExited(candidate);
      throw error;
    }
    return candidate;
  }

  async function getEditor(
    isCurrent: IsCurrent,
  ): Promise<ManagedEditor | undefined> {
    if (!(await isCurrent())) return;
    if (launching) {
      const candidate = await launching;
      if (candidate || !(await isCurrent())) return candidate;
      return getEditor(isCurrent);
    }
    if (editor) return editor;
    if (!env.TMUX) {
      throw new Error(
        "Neovim navigation needs tmux: run Pi inside tmux, or configure an existing absolute Neovim socket (nvim --listen /path/to/socket)",
      );
    }
    launching = launch(isCurrent);
    try {
      return await launching;
    } finally {
      launching = undefined;
    }
  }

  return {
    async open(location, { socket, signal, isCurrent = () => true } = {}) {
      const current = async () =>
        !signal?.aborted && (await isCurrent()) && !signal?.aborted;
      if (!(await current()) || signal?.aborted) return;
      let candidate =
        socket === undefined ? await getEditor(current) : undefined;
      if (!(await current()) || signal?.aborted) return;
      let socketPath = candidate?.socket ?? socket;
      let rpc;
      try {
        rpc = await connect(socketPath, { timeoutMs });
      } catch (error) {
        if (!(await current()) || signal?.aborted) return;
        if (!candidate || !(await discardIfExited(candidate))) throw error;
        if (!(await current()) || signal?.aborted) return;
        candidate = await getEditor(current);
        if (!(await current()) || signal?.aborted) return;
        socketPath = candidate?.socket;
        rpc = await connect(socketPath, { timeoutMs });
      }
      try {
        if (!(await current()) || signal?.aborted) return;
        return await openInEditor({
          location,
          socket: socketPath,
          rpc,
          fs,
          signal,
          isCurrent,
        });
      } finally {
        rpc.close();
      }
    },
  };
}
