# pi-intellisense

Language-server hover and source navigation in the existing Pi transcript. With the patched `pi-tab-focus` bridge, move onto an identifier, press `K` for inline hover or `gd` to open its definition in Neovim. No model turn, separate code viewer or source edits.

**The default is workspace-symbol lookup, not semantic analysis of arbitrary chat.** A matching declaration supplies real file context, but a name match does not prove that a transcript expression refers to that declaration. Receiver types, local scope, overload selection and code that exists only in chat are not generally recoverable. Verified read results and unchanged quotes can supply exact source positions instead.

## Setup

Requires Node **22.19+**, Pi **1.3.0** and a language server. The [pi-packages repository](https://github.com/philvernon/pi-packages) bundles this extension with its source-aware `pi-tab-focus` bridge.

Before switching, disable the old `npm:pi-tab-focus` entry and any standalone local copies in `pi config`, and stop passing their `-e` flags. Installing the bundle does not disable other sources; loading both creates two independent transcript focus owners.

Install the bundle once:

```sh
pi install git:github.com/philvernon/pi-packages
```

For local development, use `pi install /path/to/pi-packages` instead of the GitHub source. Do not enable both sources or add separate `-e` entries for either extension. If using `pi-vim`, keep it before the bundle in your package settings.

Run normal Pi in fullscreen mode inside tmux. No wrapper or prestarted Neovim is required. Outside tmux, configure an existing Neovim socket. The extension itself does not install software or modify global configuration.

For TypeScript/JavaScript, put `typescript-language-server` on `PATH` and install TypeScript in the inspected workspace. Defaults for other languages are `basedpyright-langserver`, `rust-analyzer`, `gopls` and `lua-language-server`; those servers have not all been live-certified here.

This is a source-loaded Pi package: `package.json` points to `src/index.ts`, with explicit local `.ts` imports. Pi's [extension runtime](https://pi.dev/docs/latest/extensions) uses `jiti` without a compilation step; its [package manifest](https://pi.dev/docs/latest/packages) supports TypeScript entries. The Node test runner executes the same erasable TypeScript directly. `npm run build` checks types and imports the entry; it emits no bundle.

## Use

1. Expand a `read` result if necessary, or find an identifier in an assistant message.
2. `Tab` focuses the transcript; `v` enters its existing visual cursor mode.
3. Move onto the identifier using Vim motions.
4. `K` opens inline type/documentation hover. `Esc` closes only the popup; `Tab` closes it and returns to the prompt.
5. `gd` opens a verified destination in Neovim. Multiple matches require the inline picker.

Hover and location pickers share one borderless popup frame for Pi's `customMessageBg` theme color, padding, content-based sizing and placement below the code (or above when needed). Use `j`/`k` or arrow keys to scroll hover overflow or select a location. Picker labels show decoded, workspace-relative paths with line and column; long paths are shortened without changing navigation targets.

`gr` references, `gD` declaration, `gi` implementation and `gy` type definition use the same location flow. Item-mode `K`, motions, selection and yanks remain owned by `pi-tab-focus`.

## Source identity and limits

- **Workspace default:** ask LSP `workspace/symbol` for the identifier under the cursor. Resolve exact-name hits through `textDocument/definition` so imports and re-exports of the same declaration count once. One distinct target is automatic; genuinely different targets use a picker. `K`, `gd` and `gr` then request LSP hover, definition and references respectively at the resolved source position. Only references lists usages. Missing matches are reported, not replaced with a fake isolated snippet and misleading `any`.
- **Native reads:** use the exact persisted `toolCallId`, normalized path and actual read offset/limit. Returned code must still match disk. The displayed result need not contain a filename.
- **Read-backed quotes:** an unchanged contiguous quote can recover a unique source position from successful read history. Common leading indentation changes are supported. Ambiguous or stale history does not establish source identity; workspace lookup can still run.
- **Optional annotations:** `source="src/client.ts" lines="42-43"` fence attributes explicitly select an inclusive, 1-based range. The entire range must match disk, including indentation; only CRLF line endings are normalized. Malformed, stale, missing or out-of-root bindings fail locally. Pi hides attributes while retaining original session Markdown.

````markdown
```ts source="src/client.ts" lines="42-43"
const client = createClient();
await client.connect();
```
````

Exact mapping requires complete, unambiguous regions of at most 2,000 lines. Wrapped, truncated, oversized and diff regions do not gain guessed file positions; a visible identifier can still use name lookup. Identical prose cannot borrow a fence's source identity. Pi 1.3's three-space tab expansion and terminal widths are mapped back to UTF-16 source offsets; Neovim receives UTF-8 byte columns. LSP servers must support UTF-16 positions.

Cold TypeScript/JavaScript lookup opens one actual workspace source to load its project, preferring `src/` and skipping dependency/generated trees. It does not index every independent monorepo project or guarantee every symbol kind is searchable.

Native read aliases (`@`, `~`, Unicode spaces and file URLs) are normalized. Pi's extra macOS filename fallbacks (AM/PM spacing, NFD and curly quotes) are not mirrored; those reads safely remain unmapped.

## Neovim and configuration

Optional configuration is `~/.pi/agent/pi-intellisense.json`, or under `PI_CODING_AGENT_DIR`:

```json
{
  "timeoutMs": 5000,
  "nvimSocket": "env:NVIM",
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

The default `env:NVIM` checks `PI_INTELLISENSE_NVIM`, then `NVIM`, for an absolute socket path; absent one, the first jump lazily opens Neovim in the current tmux server. An absolute `nvimSocket` reuses that server; `auto` ignores inherited sockets and uses an on-demand split.

A configured broken socket reports an error, never an unexpected fallback editor. Concurrent first jumps share startup. Managed editors are reused for the session and replaced only after confirmed exit; uncertain failures do not create duplicates. Pi shutdown does not kill Neovim or discard unsaved work. After reloading Pi, configure the old socket explicitly to keep using that editor. Existing-editor host focus is not switched automatically.

Paths are structured arguments/RPC data, never executable shell or Ex text. Sources and destinations must resolve to existing files inside the workspace. Source hashes and request currency are rechecked through startup and immediately before navigation. LSP text is sanitized, and cancelled/stale results cannot reopen UI.

Language servers are queried directly over stdio. No `pi-tools`, Sidekick or Neovim configuration changes are made. Full Sidekick embedding and pi-vim outer-mode interactions remain unverified.

## Development and verification

From the repository root:

```sh
npm run setup                # install each package's locked development dependencies
npm run build                # both strict typechecks + IntelliSense entry import
npm test                     # both packages' unit/native suites
npm run test:integration      # real TS LSP and isolated Pi/tmux/Neovim
npm run check                # build and every test suite
```

Each package retains its own npm scripts and dependency lockfile. The real Pi tests load the root bundle, including the sibling `pi-tab-focus`, without an external bridge path.

All tests and fixtures are TypeScript, included in `strict: true`, `noEmit: true` checking. Mocks use production dependency interfaces; incomplete Pi UI hosts are isolated at the test boundary. No test framework, transpiler, global formatter or runtime compilation dependency is added.

Integration needs `pi`, `tmux`, `nvim` and `typescript-language-server` on `PATH`, and workspace TypeScript. All four Pi-terminal cases run against the bundled bridge; none skip for a missing external bridge setting. Tests use offline fixture sessions, private configuration and separately named tmux servers, with no model requests. Cleanup targets only test-owned processes/files. Short `/tmp` paths keep Neovim Unix sockets within macOS length limits. Cold LSP requests can be slower under concurrent verification workloads.

Passing tests verify the exercised fixtures, not universal transcript semantics or every host/server combination.

Coverage includes provenance/path safety, Unicode coordinates, bridge validation and lifecycle, real entry registration, inline hover/picker ownership, cancellation/reflow/source races, lazy editor startup/recovery, stdio transport and wire framing. Real integration checks imported-method context recovery, cold workspace lookup with explicit/inferred language, lazy Neovim reuse and actual buffer/cursor positions, plus real Pi `K`/`gd` for annotated fences, reads, read-backed quotes and workspace-only code. Real Pi `gr` is checked separately to open a usage rather than the declaration, reusing the editor opened by `gd`.

The bridge remains the sole input owner. Its contract and safety/lifecycle requirements are in [SPEC.md](SPEC.md), the single maintained implementation specification. The retired standalone `/intel` viewer, wrapper binary and duplicate controllers are not product paths.
