# pi-tab-focus

Crush-style transcript focus mode for Pi. Navigate, select and copy transcript content without leaving the terminal.

## Install

```sh
pi install npm:pi-tab-focus
```

Run Pi in fullscreen mode:

```sh
pi --tui-mode fullscreen
```

### pi-vim

`pi-tab-focus` works with Pi's built-in editor and supports `pi-vim`. If you use both, install `pi-vim` first:

```sh
pi install npm:pi-vim
pi install npm:pi-tab-focus
```

The same ordering should be used in `settings.json`.

## Usage

Press `Tab` to enter transcript focus. Press `Tab` or `Esc` to return to the editor.

| Key | Action |
| --- | --- |
| `j` / `↓` | scroll down |
| `k` / `↑` | scroll up |
| `u` / `d` | half-page up / down |
| `Shift+J` / `Shift+↓` | next transcript item |
| `Shift+K` / `Shift+↑` | previous transcript item |
| `b` / `PgUp` | page up |
| `f` / `PgDn` | page down |
| `g` / `Home` | top |
| `G` / `End` | bottom |
| `y` / `c` | copy selected item or visual selection |
| `v` | visual cursor / character selection |
| `V` | line selection |
| `Enter` | open the first link in the selected item; in visual mode, open the link under the cursor |
| `:` | open EX mode when using `pi-vim` |
| `Ctrl+O` | toggle tool output |
| `Ctrl+T` | toggle thinking visibility |
| `Ctrl+C` | return to editor focus |
| `Ctrl+D` | shut down Pi |

Visual mode supports familiar Vim-style navigation including `h/j/k/l`, word motions, counts, `f/F/t/T`, `gg/G`, paragraph motions and common text objects such as `iw`, `aw` and quoted/bracketed selections.

## Configuration

`Tab` is the default focus key. To change it globally, create `~/.pi/agent/pi-tab-focus.json`:

```json
{
  "focusKey": "f6",
  "hideDefaultScrollIndicator": true
}
```

A trusted project can override this with `.pi/pi-tab-focus.json`. Use Pi's normal key format and run `/reload` after changing the config.

Prefer modifier or function-key bindings for `focusKey` (for example `ctrl+g` or `f6`). An unmodified printable key such as `f` will intercept normal typing while Pi is in fullscreen mode.

Set `hideDefaultScrollIndicator` to `false` if you want to keep Pi's built-in "Jump to latest message" indicator.

## Compatibility

Tested with Pi `0.85.1`.

Optional `pi-vim` integration is tested with `pi-vim` `0.14.2`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```
## Optional native Pi IntelliSense bridge (source checkout)

The source checkout on GitHub main includes an experimental, session-scoped Pi event-bus bridge for [pi-intellisense](https://github.com/philvernon/pi-intellisense). The original transcript remains owned by pi-tab-focus. While its visual cursor is active on code, `K` delegates hover and `gd` delegates definition; item-level uppercase `K`, all legacy motions and yank remain unchanged.

The bridge exposes `isCurrent()` on focus snapshots to suppress stale LSP responses after mode/cursor/layout changes. A capturing IntelliSense hover popup uses `Esc` to close and remain in transcript mode, or `Tab` to close and signal `pi-intellisense:return-to-editor:v1`, restoring the prompt editor. Pending `g` prefixes are cleared when leaving visual mode.

The npm release may not yet include this patch; when developing locally, run Pi with `-e /path/to/pi-tab-focus/src/index.ts -e /path/to/pi-intellisense/src/index.ts` and avoid loading a second installed copy of the tab-focus extension. The integration does not enable semantic mapping by itself: use the pi-intellisense provider/provenance configuration and see its docs.

The bridge dispatch and focus transitions are covered by local automated tests, but its long wrapped-code and full Sidekick/tmux integration remain areas for further testing.
