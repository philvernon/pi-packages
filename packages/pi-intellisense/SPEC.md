# Native transcript IntelliSense

## Scope and interaction

The existing Pi transcript is the only code viewer. `pi-tab-focus` owns input; this extension resolves source context, queries a local language server, presents inline UI and opens validated destinations in Neovim.

- `Tab` focuses the transcript, `v` enters the existing visual cursor and `K` requests hover beside the symbol.
- `Esc` dismisses only hover. `Tab` dismisses and returns to the prompt. Existing motions, selection, yanks and item-mode `K` remain intact.
- `gd` definition, `gr` references, `gD` declaration, `gi` implementation and `gy` type definition share location validation and an inline picker for multiple destinations.
- No model turn, source edit, completion application, separate viewer, competing input listener, transcript upload or automatic global configuration change.

## Context resolution

**Workspace-symbol lookup is the default, not semantic interpretation of arbitrary transcript text.** Extract the visible identifier and ask LSP `workspace/symbol`. Resolve exact-name hits through `textDocument/definition` and deduplicate real definition targets before offering a picker; imports and re-exports of one declaration are not separate choices. One distinct target is automatic; genuinely different targets require selection. At the resolved real position, `K` requests `textDocument/hover`, `gd` requests `textDocument/definition` and `gr` requests `textDocument/references` without including the declaration. Known source positions bypass workspace search. A name match does not prove transcript scope, receiver identity, inferred types or overload resolution. Missing matches are reported without presenting isolated-snippet `any` as project-aware information.

Fence language selects a server when available; otherwise a workspace source supplies the language. Cold TypeScript/JavaScript lookup attaches one real source file to load its project, preferring `src/`, excluding dependency/generated/hidden trees and symlink discovery. Use a semantic TypeScript server rather than incomplete syntax-only cold results. Independent monorepo projects and unindexed symbol kinds are not guessed.

Exact positions are optional fast paths:

1. Native `read` provenance uses the exact persisted `toolCallId`, normalized path and actual offset/limit. Raw output must match disk. Reconstruct limit notices only from the actual arguments; never strip number-like raw source as line labels or borrow unrelated tool results.
2. Unannotated quotes may recover a unique contiguous location from successful read history, allowing common leading indentation changes while preserving UTF-16 columns. Failed/truncated reads, stale candidates and ambiguous matches cannot assert file identity.
3. Optional fence metadata follows `ts source="src/client.ts" lines="42-43"`: language token, JSON-quoted path, quoted inclusive 1-based range. Validate the complete range against current source, normalizing only CRLF. Malformed, stale, missing or unsafe explicit bindings fail locally rather than silently changing source context.

Original assistant Markdown is required for fence identity. Hide annotation attributes only through `registerMarkdownTransformer`; retain session text. Prose filenames are not authority. Whole displayed regions must match contiguously and unambiguously, within actual fence boundaries and original block order. Repeated source lines use their displayed row. Map Pi's three-space tabs, ANSI styling, wide glyphs and combining marks to original UTF-16 positions. Unsupported wrapping, truncation, oversized regions (>2,000 lines) and diffs cannot claim exact file positions, though visible names can use workspace lookup.

`before_agent_start` requests ordinary language fences, not annotations or prior reads. Unbound transcript identifiers become workspace-symbol queries, not synthetic documents.

## Bridge and request lifetime

Register via `pi-intellisense:register:v1`, unregister via `pi-intellisense:unregister:v1`, and handle load order/reload via `pi-tab-focus:availability:v1`. The typed registration exposes only implemented semantic actions and validates unknown snapshot/action payloads at the boundary.

Snapshots carry original `sourceText`, exact `toolCallId`, styled `renderedLines`, absolute `renderedStartRow`, session/item identity, transcript/layout revisions, visual/screen cursor and `isCurrent()`. Hidden annotation changes invalidate currency even when rendering is unchanged. Item, input/focus intent, cursor, reflow and viewport changes suppress obsolete requests.

After selecting a target, `isNavigationCurrent()` permits reflow caused by the operation's own tmux split, but rejects new input, source/session changes or newer requests. `withNavigationPicker(run)` exempts only that request's own picker input, not foreign transient UI. Preserve visible startup/RPC errors while navigation intent remains current. Revalidate source hashes after asynchronous work and immediately before navigation RPC.

Session replacement/shutdown unregisters handlers, cancels pending work, closes overlays and owned LSP/RPC resources, and prevents late responses from reopening UI. Do not kill Neovim. Actual keyboard ownership and observer behavior are tested in the companion checkout, not a parallel implementation here. Pi 1.3 assistant `lastMessage` access is a private compatibility boundary: future renderer changes must fail to unknown provenance, never guessed source identity.

## Language-server and editor safety

- Start configured stdio servers lazily with structured argv and `shell: false`; no rendering hook starts a server or waits synchronously for LSP.
- Share initialization and cold project attachment. Cancelling one waiter cannot cancel others or poison the cache. Bound requests/startup and suppress stale results. Close owned transports idempotently.
- Advertise UTF-16 only; reject incompatible negotiation. Normalize hover and Location/LocationLink responses, deduplicate destinations and sanitize terminal display text.
- Canonicalize workspace/source/destinations with realpath. Open only existing files inside the workspace, not arbitrary URI schemes, path-prefix collisions, escaped symlinks or guessed repository hits.
- Prefer an explicitly configured socket, then configured environment sockets. `auto` forces on-demand launch; never discover arbitrary Neovim processes or fall back after an explicit socket failure.
- Without a socket, launch one visible Neovim split in the current tmux server, using a private socket directory, bounded readiness and one shared in-flight launch. Reuse is session-scoped. Replace only after confirmed editor exit; uncertain failures must not duplicate or kill editors.
- Send filenames and positions as structured RPC data, never interpolated shell/Ex/Lua instructions. Convert zero-based UTF-16 positions to one-based Neovim lines and zero-based UTF-8 byte columns. Respect editor failures without replaying navigation blindly. Existing-editor host focus is not switched automatically.

## Implementation and verification boundary

Production entry is `src/index.ts`; provenance/mapping/controller live under `src/native/`, bridge under `src/bridge/`, and LSP/runtime and Neovim adapters in their corresponding source modules. Local imports explicitly use `.ts`; Pi loads through `jiti`, Node executes erasable TypeScript directly, and strict `noEmit` checking includes tests. Use Node's built-in test runner only.

Acceptance gates:

- Unit/native suites cover production components, malformed bridge payloads/actions, complete-range provenance, unsafe/stale/ambiguous input, Unicode coordinates, cancellation through startup, overlay/picker ownership, source revalidation, initialization races and structured transport/editor behavior.
- `npm run build` strictly checks source and tests, then imports the entry without emitting output files.
- Deliberate integration runs use real TypeScript LSP, tmux and Neovim, verifying imported-method quote recovery, cold workspace lookup, editor reuse and exact buffer/cursor positions.
- Loading the root bundle with its sibling `pi-tab-focus`, offline saved Pi sessions exercise actual `K`/`gd` for annotated fences, expanded reads, read-backed quotes and workspace-only code; `gr` opens a usage rather than the declaration and reuses the same editor. No model requests or user tmux/editor sessions are involved. Companion tests separately verify the real input owner.

Setup, prerequisites and verification commands are maintained in [README.md](README.md). The bridge and IntelliSense ship together in the root package manifest. Full Sidekick embedding, pi-vim outer modes, arbitrary renderer changes, lossless wrapped/diff provenance and all language servers remain outside the verified boundary.
