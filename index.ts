/**
 * pi-scratch — summon a throwaway terminal inside Pi.
 *
 *   /term               open the scratch shell (state is reused)
 *   /term <command>     run one command there, then come straight back
 *   /term --reset       forget cwd/env and start clean
 *   ctrl+alt+t          same as /term
 *
 * Pi's TUI is suspended while the shell owns the terminal, so anything that
 * needs a real tty works: vim, htop, git rebase -i, tmux, ssh, REPLs, ...
 *
 * State reuse: each session gets ~/.pi/agent/scratch/<session-id>/. A wrapper
 * rc file (ZDOTDIR for zsh, --rcfile for bash) restores the previous cwd and
 * exported environment, and re-saves them before every prompt. History is
 * already shared through the shell's own HISTFILE.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LABEL = "scratch";

export type ShellKind = "zsh" | "bash" | "other";

/** zsh: our ZDOTDIR wrapper. Chain the user's own rc files, then restore + hook. */
const ZSHENV_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"',
].join("\n");

const ZSHRC_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
	"",
	"__pi_scratch_save() {",
	"\temulate -L zsh",
	'\tlocal tmp="$PI_SCRATCH_STATE/state.sh.tmp"',
	"\t{",
	'\t\tprint -r -- "[[ -d ${(q)PWD} ]] && cd -- ${(q)PWD}"',
	"\t\texport -p",
	'\t} >| "$tmp" 2>/dev/null && mv -f "$tmp" "$PI_SCRATCH_STATE/state.sh"',
	"}",
	"",
	'if [[ -f "$PI_SCRATCH_STATE/state.sh" ]]; then',
	'\tsource "$PI_SCRATCH_STATE/state.sh"',
	"fi",
	"",
	"autoload -Uz add-zsh-hook",
	"add-zsh-hook precmd __pi_scratch_save",
	"add-zsh-hook zshexit __pi_scratch_save",
	"",
	"# nested shells should behave like the user's normal ones",
	"unset ZDOTDIR",
].join("\n");

/** bash: passed via --rcfile. */
const BASHRC_RC = [
	"# managed by pi-scratch, rewritten on every run - do not edit",
	'[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"',
	'[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
	"",
	"__pi_scratch_save() {",
	'\tlocal tmp="$PI_SCRATCH_STATE/state.sh.tmp"',
	"\t{",
	"\t\tprintf '[[ -d %q ]] && cd -- %q\\n' \"$PWD\" \"$PWD\"",
	"\t\texport -p",
	'\t} >"$tmp" 2>/dev/null && mv -f "$tmp" "$PI_SCRATCH_STATE/state.sh"',
	"}",
	"",
	'[ -f "$PI_SCRATCH_STATE/state.sh" ] && . "$PI_SCRATCH_STATE/state.sh"',
	"",
	'case "$PROMPT_COMMAND" in',
	"\t*__pi_scratch_save*) ;;",
	'\t*) PROMPT_COMMAND="__pi_scratch_save${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
	"esac",
	"trap __pi_scratch_save EXIT",
].join("\n");

export function shellKind(shell: string = process.env.SHELL || "/bin/sh"): ShellKind {
	const name = basename(shell).replace(/^-/, "");
	if (name === "zsh") return "zsh";
	if (name === "bash") return "bash";
	return "other";
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
): { shell: string; args: string[]; env: NodeJS.ProcessEnv } {
	const shell = process.env.SHELL || "/bin/sh";
	const env: NodeJS.ProcessEnv = { ...process.env, PI_SCRATCH: "1", PI_SCRATCH_STATE: dir };
	if (kind === "zsh") {
		env.ZDOTDIR = join(dir, "zdotdir");
		return { shell, args: command ? ["-i", "-c", oneShotScript(command)] : ["-i"], env };
	}
	if (kind === "bash") {
		const rc = join(dir, "bashrc");
		return {
			shell,
			args: command ? ["--rcfile", rc, "-i", "-c", oneShotScript(command)] : ["--rcfile", rc, "-i"],
			env,
		};
	}
	return { shell, args: command ? ["-i", "-c", command] : ["-i"], env };
}

function tilde(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function openScratchTerminal(args: string, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${LABEL}: needs the interactive TUI`, "error");
		return;
	}

	const raw = args.trim();
	const reset = raw === "--reset" || raw === "-r";
	const command = reset ? "" : raw.startsWith("-- ") ? raw.slice(3).trim() : raw;

	const kind = shellKind();
	const dir = scratchStateDir(ctx.sessionManager.getSessionFile(), process.pid);
	if (reset) {
		rmSync(dir, { recursive: true, force: true });
		ctx.ui.notify(`${LABEL}: state cleared`, "info");
	}
	prepareScratchState(dir, kind);

	const restored = kind !== "other" && existsSync(join(dir, "state.sh"));
	const { shell, args: argv, env } = scratchInvocation(dir, kind, command || undefined);
	const cwd = ctx.cwd;

	const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
		// Hand the terminal over to the shell.
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		if (!command) {
			const state = restored ? "restored" : "new";
			process.stdout.write(`\x1b[2m${LABEL} · ${shell} · ${state} · ${tilde(dir)}\x1b[0m\r\n`);
			process.stdout.write(`\x1b[2mcwd/env are kept for the next /term · /term --reset to clear · exit to return\x1b[0m\r\n\r\n`);
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

	pi.registerShortcut("ctrl+alt+t", {
		description: "Open a scratch shell",
		handler: (ctx) => openScratchTerminal("", ctx),
	});
}
