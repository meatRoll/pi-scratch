/**
 * pi-scratch — summon a throwaway terminal inside Pi.
 *
 *   /term              open an interactive shell in the session cwd
 *   /term <command>    run one command there, then come straight back
 *   ctrl+alt+t         same as /term
 *
 * Pi's TUI is suspended while the shell owns the terminal, so anything that
 * needs a real tty works: vim, htop, git rebase -i, tmux, ssh, REPLs, ...
 * Exiting the shell returns to Pi exactly where you left it.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LABEL = "scratch";

async function openScratchTerminal(args: string, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${LABEL}: needs the interactive TUI`, "error");
		return;
	}

	const shell = process.env.SHELL || "/bin/sh";
	const command = args.trim();
	const cwd = ctx.cwd;

	const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
		// Hand the terminal over to the shell.
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		if (!command) {
			process.stdout.write(`\x1b[2m${LABEL} · ${shell} · ${cwd}\x1b[0m\r\n`);
			process.stdout.write(`\x1b[2mexit (or ctrl+d) returns to pi\x1b[0m\r\n\r\n`);
		}

		const result = spawnSync(shell, command ? ["-lc", command] : ["-il"], {
			cwd,
			stdio: "inherit",
			env: {
				...process.env,
				PI_SCRATCH: "1",
			},
		});

		// Take the terminal back.
		tui.start();
		tui.requestRender(true);

		done(result.status ?? (result.signal ? 130 : 1));
		return { render: () => [], invalidate() {} };
	});

	const failed = exitCode !== 0;
	if (command) {
		ctx.ui.notify(`${LABEL}: exited ${exitCode}`, failed ? "warning" : "info");
	} else if (failed) {
		ctx.ui.notify(`${LABEL}: shell exited ${exitCode}`, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	const handler = (args: string, ctx: ExtensionContext) => openScratchTerminal(args, ctx);

	pi.registerCommand("term", {
		description: "Open a scratch shell (or run a command in one)",
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
