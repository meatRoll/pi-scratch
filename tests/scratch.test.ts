import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	oneShotScript,
	prepareScratchState,
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
