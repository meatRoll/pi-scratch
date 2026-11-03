/**
 * pi-scratch — summon a throwaway terminal inside Pi.
 *
 *   /term               open the scratch shell (cwd/env are reused)
 *   /term <command>     run one command there, then come straight back
 *   /term --reset       forget cwd/env and start clean
 *   ctrl+alt+t          same as /term
 *
 * Pi's TUI is suspended while the shell owns the terminal, so anything that
 * needs a real tty works: vim, htop, git rebase -i, tmux, ssh, REPLs, ...
 * Exiting the shell returns to Pi exactly where you left it.
 *
 * State reuse: each session gets ~/.pi/agent/scratch/<session-id>/. A wrapper
 * rc file (ZDOTDIR for zsh, --rcfile for bash) restores the previous cwd and
 * exported environment, and re-saves them before every prompt. History stays
 * in the user's own HISTFILE. The wrapper also prints a banner and marks the
 * prompt, so a scratch shell never gets mistaken for a plain terminal where
 * pi has died.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

const LABEL = "scratch";

export type ShellKind = "zsh" | "bash" | "other";

/**
 * zsh: our ZDOTDIR wrapper. Chain the user's own rc files, keep their history
 * file (ZDOTDIR would otherwise move it into the state dir), then restore the
 * saved cwd/env, print the banner, and hook the save function.
 */
const ZSHENV_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"',
].join("\n");

const ZSHRC_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
	"",
	"# ZDOTDIR moved zsh's default history file into our state dir - keep the user's",
	'if [[ $HISTFILE == "$ZDOTDIR"/* ]]; then',
	'\tHISTFILE="$HOME/.zsh_history"',
	"fi",
	"",
	"__pi_scratch_save() {",
	"\temulate -L zsh",
	'\tlocal tmp="$PI_SCRATCH_STATE/state.sh.tmp"',
	"\t{",
	'\t\tprint -r -- "[[ -d ${(q)PWD} ]] && cd -- ${(q)PWD}"',
	"\t\t(",
	"\t\t\tunset PI_SCRATCH PI_SCRATCH_LEVEL PI_SCRATCH_ONESHOT PI_SCRATCH_RESTORED PI_SCRATCH_STATE PI_SCRATCH_STATE_DISPLAY PI_SCRATCH_PARENT_SESSION",
	"\t\t\texport -p",
	"\t\t)",
	'\t} >| "$tmp" 2>/dev/null && mv -f "$tmp" "$PI_SCRATCH_STATE/state.sh"',
	"}",
	"",
	"__pi_scratch_spawn=(",
	'\t"$PI_SCRATCH" "$PI_SCRATCH_LEVEL" "$PI_SCRATCH_ONESHOT" "$PI_SCRATCH_RESTORED" "$PI_SCRATCH_STATE" "$PI_SCRATCH_STATE_DISPLAY" "$PI_SCRATCH_PARENT_SESSION"',
	")",
	"",
	'if [[ -f "$PI_SCRATCH_STATE/state.sh" ]]; then',
	'\tsource "$PI_SCRATCH_STATE/state.sh"',
	"fi",
	"",
	"# the spawn env decides who we are; a stale state file must not override it",
	'PI_SCRATCH=$__pi_scratch_spawn[1]',
	'PI_SCRATCH_LEVEL=$__pi_scratch_spawn[2]',
	'PI_SCRATCH_ONESHOT=$__pi_scratch_spawn[3]',
	'PI_SCRATCH_RESTORED=$__pi_scratch_spawn[4]',
	'PI_SCRATCH_STATE=$__pi_scratch_spawn[5]',
	'PI_SCRATCH_STATE_DISPLAY=$__pi_scratch_spawn[6]',
	'PI_SCRATCH_PARENT_SESSION=$__pi_scratch_spawn[7]',
	"unset __pi_scratch_spawn",
	"",
	"# be loud about what just happened: pi did not exit, you are in its scratch shell",
	'if [[ -z $PI_SCRATCH_ONESHOT ]]; then',
	'\t__pi_scratch_what=restored; [[ $PI_SCRATCH_RESTORED == 1 ]] || __pi_scratch_what=new',
	'\tprint -rP -- ""',
	'\tprint -rP -- "%F{214}▌ pi scratch%f · level ${PI_SCRATCH_LEVEL:-1} · $__pi_scratch_what · %F{240}$PI_SCRATCH_STATE_DISPLAY%f"',
	'\tprint -rP -- "%F{214}▌%f exit / ctrl+d %F{240}→ 回到 pi%f · %F{240}/term --reset 清掉 cwd/env%f"',
	'\tprint -rP -- ""',
	"fi",
	'if [[ -z $PI_SCRATCH_NO_MARK ]]; then',
	'\tPROMPT="%F{214}[scratch]%f $PROMPT"',
	"fi",
	"",
	"autoload -Uz add-zsh-hook",
	"add-zsh-hook precmd __pi_scratch_save",
	"add-zsh-hook zshexit __pi_scratch_save",
	"",
	"# nested shells should behave like the user's normal ones",
	"unset ZDOTDIR",
	"unset __pi_scratch_what 2>/dev/null",
].join("\n");

/** bash: passed via --rcfile, same idea minus the ZDOTDIR history quirk. */
const BASHRC_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"',
	'[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
	"",
	"__pi_scratch_save() {",
	'\tlocal tmp="$PI_SCRATCH_STATE/state.sh.tmp"',
	"\t{",
	"\t\tprintf '[[ -d %q ]] && cd -- %q\\n' \"$PWD\" \"$PWD\"",
	"\t\t(",
	"\t\t\tunset PI_SCRATCH PI_SCRATCH_LEVEL PI_SCRATCH_ONESHOT PI_SCRATCH_RESTORED PI_SCRATCH_STATE PI_SCRATCH_STATE_DISPLAY PI_SCRATCH_PARENT_SESSION",
	"\t\t\texport -p",
	"\t\t)",
	'\t} >"$tmp" 2>/dev/null && mv -f "$tmp" "$PI_SCRATCH_STATE/state.sh"',
	"}",
	"",
	'[ -f "$PI_SCRATCH_STATE/state.sh" ] && . "$PI_SCRATCH_STATE/state.sh"',
	"",
	"# the spawn env decides who we are; a stale state file must not override it",
	'__pi_scratch_spawn="$PI_SCRATCH|$PI_SCRATCH_LEVEL|$PI_SCRATCH_ONESHOT|$PI_SCRATCH_RESTORED|$PI_SCRATCH_STATE|$PI_SCRATCH_STATE_DISPLAY|$PI_SCRATCH_PARENT_SESSION"',
	'PI_SCRATCH=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_LEVEL=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_ONESHOT=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_RESTORED=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_STATE=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_STATE_DISPLAY=${__pi_scratch_spawn%%|*}; __pi_scratch_spawn=${__pi_scratch_spawn#*|}',
	'PI_SCRATCH_PARENT_SESSION=$__pi_scratch_spawn',
	'unset __pi_scratch_spawn',
	"",
	'if [ -z "$PI_SCRATCH_ONESHOT" ]; then',
	'\tif [ "$PI_SCRATCH_RESTORED" = 1 ]; then __pi_scratch_what=restored; else __pi_scratch_what=new; fi',
	"\tprintf '\\n'",
	"\tprintf '\\033[33m▌ pi scratch\\033[0m · level %s · %s · %s\\n' \"${PI_SCRATCH_LEVEL:-1}\" \"$__pi_scratch_what\" \"$PI_SCRATCH_STATE_DISPLAY\"",
	"\tprintf '\\033[33m▌\\033[0m exit / ctrl+d \\033[2m→ 回到 pi\\033[0m · \\033[2m/term --reset 清掉 cwd/env\\033[0m\\n\\n'",
	"fi",
	'if [ -z "$PI_SCRATCH_NO_MARK" ]; then',
	"\tPS1='[scratch] '\"$PS1\"",
	"fi",
	"",
	'case "$PROMPT_COMMAND" in',
	"\t*__pi_scratch_save*) ;;",
	'\t*) PROMPT_COMMAND="__pi_scratch_save${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
	"esac",
	"trap __pi_scratch_save EXIT",
].join("\n");

const DEFAULT_SHORTCUT = "ctrl+shift+t";

const MODIFIER_TOKENS = new Set(["ctrl", "shift", "alt", "super"]);
const NAMED_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_|~{}:<>?".split(""));

/** Accepts strings shaped like a pi KeyId: one or more modifiers plus one key. */
export function isValidShortcut(id: string): boolean {
	const parts = id.trim().toLowerCase().split("+");
	const key = parts.pop() ?? "";
	if (!key || parts.length === 0) return false;
	if (new Set(parts).size !== parts.length) return false;
	if (!parts.every((part) => MODIFIER_TOKENS.has(part))) return false;
	if (key.length === 1) return /[a-z0-9]/.test(key) || SYMBOL_KEYS.has(key);
	return NAMED_KEYS.has(key);
}

/**
 * PI_SCRATCH_KEY overrides the shortcut; "none" disables it. An invalid value
 * falls back to the default and reports the problem at session start.
 */
export function resolveShortcut(raw = process.env.PI_SCRATCH_KEY): { keyId?: string; issue?: string } {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "none" || value === "off") return {};
	if (!value) return { keyId: DEFAULT_SHORTCUT };
	if (!isValidShortcut(value)) {
		return {
			keyId: DEFAULT_SHORTCUT,
			issue: `${LABEL}: PI_SCRATCH_KEY="${raw}" 不是合法按键（例：ctrl+shift+t），已回退到 ${DEFAULT_SHORTCUT}`,
		};
	}
	return { keyId: value };
}

export function shellKind(shell: string = process.env.SHELL || "/bin/sh"): ShellKind {
	const name = basename(shell).replace(/^-/, "");
	if (name === "zsh") return "zsh";
	if (name === "bash") return "bash";
	return "other";
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function tilde(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** One state directory per session, so two pi sessions don't fight over cwd/env. */
export function scratchStateDir(sessionFile: string | undefined, fallbackId: string | number = process.pid): string {
	const id = sessionFile ? (basename(sessionFile, ".jsonl").split("_").pop() ?? "") : `pid-${fallbackId}`;
	const key = id.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
	return join(agentDir(), "scratch", key);
}

/** (Re)write the wrapper rc files for this state directory. */
export function prepareScratchState(dir: string, kind: ShellKind): void {
	mkdirSync(dir, { recursive: true });
	if (kind === "zsh") {
		const zdotdir = join(dir, "zdotdir");
		mkdirSync(zdotdir, { recursive: true });
		writeFileSync(join(zdotdir, ".zshenv"), ZSHENV_RC);
		writeFileSync(join(zdotdir, ".zshrc"), ZSHRC_RC);
	} else if (kind === "bash") {
		writeFileSync(join(dir, "bashrc"), BASHRC_RC);
	}
}

/** Wrap a one-shot command so the exit code survives and state still gets saved. */
export function oneShotScript(command: string): string {
	return [
		command,
		"__pi_scratch_status=$?",
		"command -v __pi_scratch_save >/dev/null 2>&1 && __pi_scratch_save 2>/dev/null",
		"exit $__pi_scratch_status",
	].join("\n");
}

export function scratchInvocation(
	dir: string,
	kind: ShellKind,
	command?: string,
	level = 1,
	parentSession?: string,
): { shell: string; args: string[]; env: NodeJS.ProcessEnv; restored: boolean } {
	const shell = process.env.SHELL || "/bin/sh";
	const restored = kind !== "other" && existsSync(join(dir, "state.sh"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SCRATCH: "1",
		PI_SCRATCH_LEVEL: String(level),
		PI_SCRATCH_STATE: dir,
		PI_SCRATCH_STATE_DISPLAY: tilde(dir),
		PI_SCRATCH_RESTORED: restored ? "1" : "0",
	};
	if (parentSession) env.PI_SCRATCH_PARENT_SESSION = parentSession;
	if (command) env.PI_SCRATCH_ONESHOT = "1";

	if (kind === "zsh") {
		env.ZDOTDIR = join(dir, "zdotdir");
		return { shell, args: command ? ["-i", "-c", oneShotScript(command)] : ["-i"], env, restored };
	}
	if (kind === "bash") {
		const rc = join(dir, "bashrc");
		return {
			shell,
			args: command ? ["--rcfile", rc, "-i", "-c", oneShotScript(command)] : ["--rcfile", rc, "-i"],
			env,
			restored,
		};
	}
	return { shell, args: command ? ["-i", "-c", command] : ["-i"], env, restored };
}

export interface ScratchArgs {
	command: string;
	reset: boolean;
	force: boolean;
}

/** Parse `/term [--reset] [--force] [-- <command>]`. */
export function parseScratchArgs(raw: string): ScratchArgs {
	let rest = raw.trim();
	let reset = false;
	let force = false;
	for (let changed = true; changed; ) {
		changed = false;
		for (const [flag, apply] of [
			["--reset", () => (reset = true)],
			["-r", () => (reset = true)],
			["--force", () => (force = true)],
			["--nested", () => (force = true)],
		] as const) {
			if (rest === flag || rest.startsWith(`${flag} `)) {
				apply();
				rest = rest.slice(flag.length).trim();
				changed = true;
			}
		}
	}
	if (rest.startsWith("-- ")) rest = rest.slice(3).trim();
	return { command: rest, reset, force };
}

/**
 * Opening an interactive shell from an already nested pi would stack another
 * pi -> shell -> pi layer. One-shot commands are fine: the shell exits by itself.
 */
export function nestingBlocked(options: { level: number; hasCommand: boolean; force: boolean }): boolean {
	return options.level >= 1 && !options.hasCommand && !options.force;
}

export type NestedSession =
	| { kind: "none" }
	| { kind: "nested" }
	/** The nested pi resumed the very session file the suspended outer pi still owns. */
	| { kind: "same-session" };

export function checkNestedSession(options: {
	level: number;
	sessionFile?: string;
	parentSession?: string;
}): NestedSession {
	if (!Number.isFinite(options.level) || options.level <= 0) return { kind: "none" };
	if (options.sessionFile && options.parentSession && options.sessionFile === options.parentSession) {
		return { kind: "same-session" };
	}
	return { kind: "nested" };
}

async function openScratchTerminal(args: string, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${LABEL}: needs the interactive TUI`, "error");
		return;
	}

	const { command, reset, force } = parseScratchArgs(args);
	const spawnLevel = Number(process.env.PI_SCRATCH_LEVEL || 0);
	const allowNested = process.env.PI_SCRATCH_ALLOW_NESTED === "1";
	if (nestingBlocked({ level: spawnLevel, hasCommand: command !== "", force: force || allowNested })) {
		ctx.ui.notify(
			`${LABEL}: 当前 pi 已经跑在 scratch shell 里（level ${spawnLevel}），不再往外套一层。exit 回外层 pi 再 /term；确实要套用 /term --force`,
			"warning",
		);
		return;
	}

	const kind = shellKind();
	const dir = scratchStateDir(ctx.sessionManager.getSessionFile(), process.pid);
	if (reset) {
		rmSync(dir, { recursive: true, force: true });
		ctx.ui.notify(`${LABEL}: state cleared`, "info");
	}
	prepareScratchState(dir, kind);

	const level = spawnLevel + 1;
	const parentSession = ctx.sessionManager.getSessionFile();
	const { shell, args: argv, env } = scratchInvocation(dir, kind, command || undefined, level, parentSession);
	const cwd = ctx.cwd;

	const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
		// Hand the terminal over. Do not clear the screen: leaving pi's last frame
		// visible is what tells the user pi is still alive behind the shell.
		tui.stop();
		if (kind === "other" && !command) {
			process.stdout.write(`\r\n\x1b[33m▌ pi scratch\x1b[0m · ${shell} · exit to return\r\n\r\n`);
		}

		const result = spawnSync(shell, argv, { cwd, stdio: "inherit", env });

		// Take the terminal back.
		tui.start();
		tui.requestRender(true);

		done(result.status ?? (result.signal ? 130 : 1));
		return { render: () => [], invalidate() {} };
	});

	if (command) {
		ctx.ui.notify(`${LABEL}: exited ${exitCode}`, exitCode === 0 ? "info" : "warning");
	} else if (exitCode !== 0) {
		ctx.ui.notify(`${LABEL}: shell exited ${exitCode}`, "warning");
	}
	if (kind === "other") {
		ctx.ui.notify(`${LABEL}: cwd/env reuse needs zsh or bash (using ${basename(shell)})`, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	const handler = (args: string, ctx: ExtensionContext) => openScratchTerminal(args, ctx);

	pi.registerCommand("term", {
		description: "Open the scratch shell (--reset to clear state)",
		handler,
	});
	pi.registerCommand("scratch", {
		description: "Alias for /term",
		handler,
	});

	const shortcut = resolveShortcut();
	if (shortcut.keyId) {
		pi.registerShortcut(shortcut.keyId as KeyId, {
			description: `Open the scratch shell (${shortcut.keyId})`,
			handler: (ctx) => openScratchTerminal("", ctx),
		});
	}

	// A pi started from inside a scratch shell is nested; say so instead of
	// looking like the outer pi silently vanished.
	pi.on("session_start", (_event, ctx) => {
		if (shortcut.issue) ctx.ui.notify(shortcut.issue, "warning");
		const level = Number(process.env.PI_SCRATCH_LEVEL || 0);
		const nested = checkNestedSession({
			level,
			sessionFile: ctx.sessionManager.getSessionFile(),
			parentSession: process.env.PI_SCRATCH_PARENT_SESSION,
		});
		if (nested.kind === "none") return;
		if (nested.kind === "same-session") {
			ctx.ui.setStatus("pi-scratch", `⛔ same session as parent pi · scratch level ${level}`);
			ctx.ui.notify(
				`${LABEL}: 这个 pi 和挂起的外层 pi 用的是同一个 session 文件，两边会各写一条分支。用 /new 开新会话，或 exit 回外层。`,
				"error",
			);
			return;
		}
		ctx.ui.setStatus("pi-scratch", `⚠ nested pi · scratch level ${level}`);
		ctx.ui.notify(`${LABEL}: 这个 pi 跑在 scratch shell 里（level ${level}）· exit 退回外层 pi`, "warning");
	});
}
