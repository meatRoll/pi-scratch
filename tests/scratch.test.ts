import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	isValidShortcut,
	oneShotScript,
	prepareScratchState,
	resolveShortcut,
	scratchInvocation,
	scratchStateDir,
	shellKind,
} from "../index.ts";

function hollowHome(): string {
	const home = mkdtempSync(join(tmpdir(), "pi-scratch-home-"));
	return home;
}

function runOneShot(dir: string, kind: "zsh" | "bash", command: string, home: string, shell: string) {
	const { args, env } = scratchInvocation(dir, kind, command);
	return spawnSync(shell, args, {
		cwd: tmpdir(),
		env: { ...env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

test("shellKind detects zsh, bash and others", () => {
	assert.equal(shellKind("/bin/zsh"), "zsh");
	assert.equal(shellKind("/usr/local/bin/bash"), "bash");
	assert.equal(shellKind("/opt/homebrew/bin/fish"), "other");
	assert.equal(shellKind("-zsh"), "zsh");
});

test("scratchStateDir keys off the session id", () => {
	const dir = scratchStateDir("/Users/me/.pi/agent/sessions/--a-b--/2026-11-03T14-05-38-162Z_01a1a1ba-d3f1.jsonl");
	assert.match(dir, /pi\/agent\/scratch\/01a1a1ba-d3f1$/);
	assert.match(scratchStateDir(undefined, 4242), /scratch\/pid-4242$/);
});

test("oneShotScript keeps the command's exit code", () => {
	assert.match(oneShotScript("false"), /^false\n/);
	assert.match(oneShotScript("false"), /exit \$__pi_scratch_status$/);
});

test("zsh restores cwd and exported env on the next run", { skip: shellKind("/bin/zsh") !== "zsh" }, () => {
	const shell = "/bin/zsh";
	const home = hollowHome();
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	const work = mkdtempSync(join(tmpdir(), "pi-scratch-work-"));
	prepareScratchState(dir, "zsh");

	const first = runOneShot(dir, "zsh", `cd ${work} && export PI_SCRATCH_TEST=42 && pwd`, home, shell);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(first.stdout.trim(), work);
	assert.ok(existsSync(join(dir, "state.sh")), "state.sh should be written");

	const second = runOneShot(dir, "zsh", "pwd; echo value=$PI_SCRATCH_TEST", home, shell);
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(second.stdout.trim().split("\n"), [work, "value=42"]);
});

test("bash restores cwd and exported env on the next run", { skip: shellKind("/bin/bash") !== "bash" }, () => {
	const shell = "/bin/bash";
	const home = hollowHome();
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	const work = mkdtempSync(join(tmpdir(), "pi-scratch-work-"));
	prepareScratchState(dir, "bash");

	const first = runOneShot(dir, "bash", `cd ${work} && export PI_SCRATCH_TEST=43 && pwd`, home, shell);
	assert.equal(first.status, 0, first.stderr);
	assert.equal(first.stdout.trim(), work);

	const second = runOneShot(dir, "bash", "pwd; echo value=$PI_SCRATCH_TEST", home, shell);
	assert.equal(second.status, 0, second.stderr);
	assert.deepEqual(second.stdout.trim().split("\n"), [work, "value=43"]);
});

test("resetting the state directory drops the saved cwd", { skip: shellKind("/bin/zsh") !== "zsh" }, () => {
	const shell = "/bin/zsh";
	const home = hollowHome();
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	const work = mkdtempSync(join(tmpdir(), "pi-scratch-work-"));
	prepareScratchState(dir, "zsh");

	runOneShot(dir, "zsh", `cd ${work} && export PI_SCRATCH_TEST=44`, home, shell);
	rmSync(dir, { recursive: true, force: true });
	prepareScratchState(dir, "zsh");
	assert.equal(existsSync(join(dir, "state.sh")), false);

	const after = runOneShot(dir, "zsh", "pwd; echo value=${PI_SCRATCH_TEST:-unset}", home, shell);
	assert.equal(after.status, 0, after.stderr);
	assert.deepEqual(after.stdout.trim().split("\n"), [realpathSync(tmpdir()), "value=unset"]);
});

test("state file is shell-sourceable and free of prompt noise", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	runOneShot(dir, "zsh", "export PI_SCRATCH_TEST=45", hollowHome(), "/bin/zsh");
	const state = readFileSync(join(dir, "state.sh"), "utf8");
	assert.doesNotMatch(state, /^(export )?(PS1|PROMPT|RPROMPT)=/m);
	assert.match(state, /^export PI_SCRATCH_TEST=45$/m);
});

test("wrapper rc files are regenerated without stale content", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	mkdirSync(join(dir, "zdotdir"), { recursive: true });
	prepareScratchState(dir, "zsh");
	const zshrc = readFileSync(join(dir, "zdotdir", ".zshrc"), "utf8");
	assert.match(zshrc, /^__pi_scratch_save\(\) \{$/m);
	assert.match(zshrc, /add-zsh-hook precmd __pi_scratch_save/);
	assert.match(readFileSync(join(dir, "zdotdir", ".zshenv"), "utf8"), /\$HOME\/\.zshenv/);
});

test("interactive zsh prints the banner and marks the prompt", () => {
	const home = hollowHome();
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	const { args, env } = scratchInvocation(dir, "zsh", undefined, 2);
	const run = spawnSync("/bin/zsh", args, {
		cwd: tmpdir(),
		env: { ...env, HOME: home, TERM: "xterm-256color" },
		input: "exit\n",
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 20000,
	});
	const all = `${run.stdout}${run.stderr}`;
	assert.match(all, /pi scratch/);
	assert.match(all, /level 2/);
	assert.match(all, /\[scratch\]/);
});

test("one-shot commands stay quiet", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	const run = runOneShot(dir, "zsh", "echo oneshot-out", hollowHome(), "/bin/zsh");
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout, "oneshot-out\n");
	assert.doesNotMatch(`${run.stdout}${run.stderr}`, /pi scratch/);
});

test("history stays in the user's HISTFILE", () => {
	const home = hollowHome();
	writeFileSync(join(home, ".zsh_history"), ": 1700000000:0;MARKER_FROM_HOME_HISTORY\n");
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	const { args, env } = scratchInvocation(dir, "zsh", undefined, 1);
	const run = spawnSync("/bin/zsh", args, {
		cwd: tmpdir(),
		env: { ...env, HOME: home, TERM: "xterm-256color" },
		input: "fc -l 1 2>&1 | cat\nexit\n",
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 20000,
	});
	assert.match(`${run.stdout}${run.stderr}`, /MARKER_FROM_HOME_HISTORY/);
});

test("control variables are not written into the saved state", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	runOneShot(dir, "zsh", "export PI_SCRATCH_KEEP=1", hollowHome(), "/bin/zsh");
	const state = readFileSync(join(dir, "state.sh"), "utf8");
	for (const name of [
		"PI_SCRATCH",
		"PI_SCRATCH_LEVEL",
		"PI_SCRATCH_ONESHOT",
		"PI_SCRATCH_RESTORED",
		"PI_SCRATCH_STATE",
		"PI_SCRATCH_STATE_DISPLAY",
	]) {
		assert.doesNotMatch(state, new RegExp(`^export ${name}=`, "m"), `${name} leaked into state.sh`);
	}
	assert.match(state, /^export PI_SCRATCH_KEEP=1$/m);
});

test("invocation env carries level and one-shot flags", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	const interactive = scratchInvocation(dir, "zsh", undefined, 3);
	assert.equal(interactive.env.PI_SCRATCH_LEVEL, "3");
	assert.equal(interactive.env.PI_SCRATCH_ONESHOT, undefined);
	const oneShot = scratchInvocation(dir, "zsh", "true", 4);
	assert.equal(oneShot.env.PI_SCRATCH_LEVEL, "4");
	assert.equal(oneShot.env.PI_SCRATCH_ONESHOT, "1");
});

test("a stale state file cannot hijack control variables", () => {
	const home = hollowHome();
	const dir = mkdtempSync(join(tmpdir(), "pi-scratch-state-"));
	prepareScratchState(dir, "zsh");
	writeFileSync(
		join(dir, "state.sh"),
		["cd -- /tmp", "export PI_SCRATCH_ONESHOT=1", "export PI_SCRATCH_LEVEL=99"].join("\n"),
	);
	const { args, env } = scratchInvocation(dir, "zsh", undefined, 2);
	const run = spawnSync("/bin/zsh", args, {
		cwd: tmpdir(),
		env: { ...env, HOME: home, TERM: "xterm-256color" },
		input: "exit\n",
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 20000,
	});
	const all = `${run.stdout}${run.stderr}`;
	assert.match(all, /pi scratch/, "banner should still show");
	assert.match(all, /level 2/, "level should come from the spawn env");
	const state = readFileSync(join(dir, "state.sh"), "utf8");
	assert.doesNotMatch(state, /PI_SCRATCH_LEVEL=99/);
	assert.doesNotMatch(state, /^export PI_SCRATCH_ONESHOT=/m);
});

test("shortcut ids are validated and resolved from PI_SCRATCH_KEY", () => {
	for (const good of ["ctrl+shift+t", "shift+ctrl+t", "ctrl+alt+t", "alt+enter", "ctrl+shift+f12", "ctrl+shift+pageUp"]) {
		assert.equal(isValidShortcut(good), true, good);
	}
	for (const bad of ["t", "ctrl+", "", "ctrl+ctrl+t", "ctrl+shift+tt", "ctrl+nope", "hyper+t"]) {
		assert.equal(isValidShortcut(bad), false, bad);
	}
	assert.equal(resolveShortcut(undefined).keyId, "ctrl+shift+t");
	assert.equal(resolveShortcut("").keyId, "ctrl+shift+t");
	assert.equal(resolveShortcut("ctrl+shift+s").keyId, "ctrl+shift+s");
	assert.equal(resolveShortcut("CTRL+SHIFT+T").keyId, "ctrl+shift+t");
	assert.deepEqual(resolveShortcut("none"), {});
	assert.deepEqual(resolveShortcut("off"), {});
	assert.equal(resolveShortcut("bogus!!").keyId, "ctrl+shift+t");
	assert.match(resolveShortcut("bogus!!").issue ?? "", /PI_SCRATCH_KEY/);
});
