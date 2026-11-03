# pi-scratch

**English** · [中文](README.zh-CN.md)

Summon a throwaway terminal inside [pi](https://github.com/earendil-works/pi).
Run whatever ad-hoc thing you need, `exit`, and you are back in pi exactly where
you left it — next time, the shell starts in the same directory with the same
exported environment.

## Why

Pi's `!bash` is fine for non-interactive commands, but it cannot run anything
that needs a real tty. This extension gives you a real terminal on demand:

- **real tty** — vim, htop, `git rebase -i`, ssh, a Python REPL, tmux all work
- **throwaway** — nothing goes into pi's context or into the session file
- **one keystroke** — `/term` or `ctrl+shift+t`, in the session's cwd
- **clearly not a crash** — pi's last frame stays on screen and the prompt is
  marked `[scratch]`, so you never mistake a suspended pi for a dead one
- **remembers** — cwd and exported environment are restored on the next call

## Requirements

- pi >= 1.4.0 (extensions are loaded through jiti, no build step)
- `zsh` or `bash` for state reuse (other shells run, but remember nothing)
- macOS or Linux

## Install

```sh
pi install git:github.com/meatRoll/pi-scratch@v1.0.1
```

For development, install the working copy instead — edits apply after `/reload`:

```sh
pi install ./            # or try it once: pi -e ./index.ts
pi update --extensions   # reconcile after pulling
```

Uninstall:

```sh
pi remove git:github.com/meatRoll/pi-scratch@v1.0.1
```

## Usage

| Input | What it does |
|---|---|
| `/term` | open the scratch shell, restoring cwd + exported env |
| `/term <command>` | run one command in that shell, then come straight back |
| `/term --reset` | forget the saved cwd/env and start clean |
| `/term --force` | allow this from a nested pi (alias `--nested`; see [Nesting](#nesting-pi--shell--pi)) |
| `/scratch` | alias for `/term` |
| `ctrl+shift+t` | shortcut, same as `/term` |

Under the hood: `tui.stop()` hands the terminal to `$SHELL` (`-i` for an
interactive shell, `-i -c` for a one-shot command), then `tui.start()` plus a
redraw when it exits — so full-screen programs are fine. Terminal I/O never
reaches pi's context or the session file.

What it looks like:

```
<pi's last frame is still above — the screen is not cleared>

▌ pi scratch · level 1 · restored · ~/.pi/agent/scratch/<session-id>
▌ exit / ctrl+d → back to pi · /term --reset clears cwd/env

[scratch] ➜  pi-scratch
```

- the banner and the `[scratch]` prefix come from the wrapper rc, which is
  rewritten on every launch — they survive `/reload`, upgrades and `--reset`
- dislike the marker? `export PI_SCRATCH_NO_MARK=1`
- one-shot mode (`/term <cmd>`) prints no banner, so the output stays clean

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PI_SCRATCH_KEY` | `ctrl+shift+t` | shortcut; any pi key id, or `none` to disable |
| `PI_SCRATCH_NO_MARK` | unset | set to anything to drop the `[scratch]` prompt prefix |
| `PI_SCRATCH_ALLOW_NESTED` | unset | `1` allows opening a terminal from a nested pi |

`ctrl+shift+<letter>` needs extended-key reporting (Kitty keyboard protocol or
xterm CSI-u). iTerm2, Ghostty, WezTerm, Kitty and Windows Terminal have it; old
terminals and some multiplexers do not. **Quick check:** if pi's own
`ctrl+shift+f` (search) works for you, `ctrl+shift+t` will too — otherwise use
`PI_SCRATCH_KEY=ctrl+alt+t`. `/hotkeys` lists what actually got registered.

## How state reuse works

One state directory per session: `~/.pi/agent/scratch/<session-id>/`

- **zsh** — `ZDOTDIR` points at a generated wrapper that sources your
  `~/.zshenv` and `~/.zshrc`, then the saved `state.sh`, and hooks
  `precmd` + `zshexit` to write it back
- **bash** — the same three layers via `--rcfile`
  (`~/.bash_profile` → `~/.bashrc` → state)
- **other shells** — they run, but nothing is remembered (you get a warning)

`state.sh` is one `cd -- '<last pwd>'` line plus the shell's own `export -p`, so
what survives is **cwd + exported variables**. History is untouched: the wrapper
points `HISTFILE` back at the user's own file (`ZDOTDIR` would otherwise move
zsh's default history file into the state directory).

Two guards keep a stale state file from hijacking a new shell:

- `PI_SCRATCH*` control variables are never written into `state.sh`
- after sourcing it, the spawn environment wins — an old file cannot change the
  level, the state directory, or the one-shot flag

## Nesting (pi → shell → pi)

A real terminal should be able to run anything, so nesting is allowed — with two
guards:

1. **No extra terminal layer.** When the current pi itself runs inside a
   scratch shell (`level ≥ 1`), `/term` and the shortcut are refused with a hint
   to `exit` first. Override with `/term --force` or
   `PI_SCRATCH_ALLOW_NESTED=1`. One-shot commands are exempt: `/term git commit`
   still works, because that shell exits by itself.
2. **No fighting over one session file.** The spawning pi's session path travels
   down as `PI_SCRATCH_PARENT_SESSION`, and a nested pi compares it with its own.
   Same file → `⛔ same session as parent pi` (both would append their own
   branch) — use `/new`, or `exit`. Different file → just
   `⚠ nested pi · scratch level N`, the normal "another pi in a subdirectory"
   case.

## Caveats

- the saved `PATH` overrides whatever `.zshrc` computes. That is what keeps
  `conda activate` / `nvm use` alive across invocations, but it also means a new
  `.zshrc` `PATH` entry will not show up until `/term --reset`
- unexported variables, shell functions and background jobs do not survive
  across invocations (that needs the tmux backend)
- two shells in the same session: last writer wins; separate sessions are isolated
- the state directory can be deleted any time — that is all `/term --reset` does

## Development

```sh
npm install          # peer deps: @earendil-works/pi-coding-agent, @earendil-works/pi-tui
npm run typecheck
npm test             # 19 tests: real zsh/bash runs, state, banner, history, hijack guards, nesting
```

Reference implementation: pi's
`packages/coding-agent/examples/extensions/interactive-shell.ts` — the official
example hooks `user_bash` to make `!cmd` interactive; this project summons the
shell on demand instead.

## Roadmap

- [x] configurable shortcut (`PI_SCRATCH_KEY`, default `ctrl+shift+t`)
- [ ] read the shortcut from pi settings instead of an environment variable
- [ ] pipe one-shot command output back into the conversation (`/term -c ...`)
- [ ] tmux backend: a truly persistent shell (background jobs, functions),
      detach with `ctrl+b d`
- [ ] overlay terminal panel (PTY + `@xterm/headless`); needs node-pty, not soon
- [ ] prune `~/.pi/agent/scratch/*` when a session is deleted

## Design tradeoffs

| Approach | real tty | reuse across calls | cost | Notes |
|---|---|---|---|---|
| Suspend TUI + `$SHELL` + state file (current) | ✅ | cwd/env | low | no external deps, takes over the screen |
| tmux attach | ✅ | everything (jobs, functions) | low | needs tmux, nested tmux is awkward |
| overlay + PTY + xterm renderer | ✅ | everything | high | looks great, needs node-pty and emulator glue |

## License

MIT
