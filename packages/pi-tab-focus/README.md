# pi-tab-focus

Crush-style transcript focus mode for Pi. Navigate, select and copy transcript content without leaving the terminal.

## Install

This repository bundles `pi-tab-focus` and `pi-intellisense`. Before switching, disable the old `npm:pi-tab-focus` entry and standalone local copies in `pi config`, and stop passing their `-e` flags. Loading both creates independent focus owners.

```sh
pi install git:github.com/philvernon/pi-packages
```

For local development, install `/path/to/pi-packages` instead of the GitHub source. Enable only one source; neither extension needs a separate `-e` entry. IntelliSense requires Pi **1.3.0** and a language server; see its [setup](../pi-intellisense/README.md#setup).

Run Pi in fullscreen mode:

```sh
pi --tui-mode fullscreen
```

### pi-vim

`pi-tab-focus` works with Pi's built-in editor and supports `pi-vim`. If you use both, install `pi-vim` first:

```sh
pi install npm:pi-vim
pi install git:github.com/philvernon/pi-packages
```

Keep `pi-vim` before the `pi-packages` bundle in `settings.json`.

## Usage

Press `Tab` to enter transcript focus. Press `Tab` or `Esc` to return to the editor.

| Key                   | Action                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `j` / `↓`             | scroll down                                                                              |
| `k` / `↑`             | scroll up                                                                                |
| `u` / `d`             | half-page up / down                                                                      |
| `Shift+J` / `Shift+↓` | next transcript item                                                                     |
| `Shift+K` / `Shift+↑` | previous transcript item                                                                 |
| `b` / `PgUp`          | page up                                                                                  |
| `f` / `PgDn`          | page down                                                                                |
| `g` / `Home`          | top                                                                                      |
| `G` / `End`           | bottom                                                                                   |
| `y` / `c`             | copy selected item or visual selection                                                   |
| `v`                   | visual cursor / character selection                                                      |
| `V`                   | line selection                                                                           |
| `Enter`               | open the first link in the selected item; in visual mode, open the link under the cursor |
| `:`                   | open EX mode when using `pi-vim`                                                         |
| `Ctrl+O`              | toggle tool output                                                                       |
| `Ctrl+T`              | toggle thinking visibility                                                               |
| `Ctrl+C`              | return to editor focus                                                                   |
| `Ctrl+D`              | shut down Pi                                                                             |

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

From the repository root, `npm run setup` installs both packages' locked dependencies and `npm run check` runs their builds and unit/native/integration suites. The real integration suite also requires `pi`, `tmux`, `nvim` and `typescript-language-server` on `PATH`.

Inside this package:

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## Native Pi IntelliSense bridge

The bundle includes a session-scoped Pi event-bus bridge for [pi-intellisense](../pi-intellisense). The original transcript remains owned by pi-tab-focus. While its visual cursor is active on code, `K` delegates hover and `gd` delegates definition; item-level uppercase `K`, all legacy motions and yank remain unchanged.

The bridge exposes `isCurrent()` on focus snapshots to suppress stale LSP responses after mode/cursor/layout changes. A capturing IntelliSense hover popup uses `Esc` to close and remain in transcript mode, or `Tab` to close and signal `pi-intellisense:return-to-editor:v1`, restoring the prompt editor. Pending `g` prefixes are cleared when leaving visual mode.

The root package manifest loads both extensions. Do not load the standalone npm release or individual extension paths alongside it. See the bundled [IntelliSense setup and source-mapping limits](../pi-intellisense/README.md).

The bridge dispatch and focus transitions are covered by local automated tests, but its long wrapped-code and full Sidekick/tmux integration remain areas for further testing.
