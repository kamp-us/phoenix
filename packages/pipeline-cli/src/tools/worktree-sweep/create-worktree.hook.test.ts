/**
 * Unit guard for the WorktreeCreate hook script (create-worktree.sh, #2924/ADR 0178):
 * the script parses a WorktreeCreate JSON payload from stdin, runs `git worktree add`,
 * and prints ONLY the resulting path to stdout on success (non-zero on any failure).
 *
 * This drives the REAL script against a REAL throwaway git repo — the same
 * against-a-real-repo idiom as command.hook.test.ts. The temp repo has NO lefthook
 * config, so `git worktree add` here does NOT fire the phoenix post-checkout
 * `bootstrap-deps` install (that ~13s install, and the live 600s-budgeted harness
 * firing that motivates the whole hook, cannot be reproduced in a unit test — it only
 * fires on a real harness spawn after a settings reload). What IS unit-testable, and is
 * what this asserts, is the script's PURE decision logic: stdin JSON parse → the git
 * command it runs → the stdout path contract → the fail-closed exit on bad input.
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const SCRIPT = fileURLToPath(
	new URL(
		"../../../../../claude-plugins/kampus-pipeline/hooks/create-worktree.sh",
		import.meta.url,
	),
);

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

describe("create-worktree.sh — WorktreeCreate hook against a REAL git repo (#2924)", () => {
	let mainRepo: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	// Run the hook script with `payload` on stdin, cwd inside the repo — exactly as
	// Claude Code fires it. Never throws: a non-zero exit is captured, not raised.
	const run = (cwd: string, payload: string): RunResult => {
		try {
			const stdout = execFileSync("bash", [SCRIPT], {cwd, input: payload, encoding: "utf8"});
			return {code: 0, stdout, stderr: ""};
		} catch (e) {
			const err = e as {status?: number; stdout?: string; stderr?: string};
			return {code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? ""};
		}
	};

	beforeAll(() => {
		mainRepo = mkdtempSync(join(tmpdir(), "wtc-main-"));
		git(mainRepo, "init", "-q", "-b", "main");
		git(mainRepo, "config", "user.email", "t@t.t");
		git(mainRepo, "config", "user.name", "t");
		writeFileSync(join(mainRepo, "README.md"), "x");
		git(mainRepo, "add", ".");
		git(mainRepo, "commit", "-q", "-m", "init");
	});

	afterAll(() => rmSync(mainRepo, {recursive: true, force: true}));

	it("creates the worktree at worktree_path from base_ref and prints ONLY that path", () => {
		const wt = join(mainRepo, ".claude", "worktrees", "wtc_ok");
		const payload = JSON.stringify({worktree_path: wt, base_ref: "main"});
		const {code, stdout} = run(mainRepo, payload);
		assert.strictEqual(code, 0);
		assert.strictEqual(stdout.trim(), wt, "stdout must be ONLY the resulting worktree path");
		assert.isTrue(existsSync(wt), "the worktree must actually be created");
		assert.isTrue(existsSync(join(wt, "README.md")), "base_ref's tree must be checked out");
	});

	it("defaults base_ref to origin/main when the payload omits it", () => {
		// Point origin at self so origin/main resolves inside the throwaway repo.
		git(mainRepo, "remote", "add", "origin", mainRepo);
		git(mainRepo, "fetch", "-q", "origin");
		const wt = join(mainRepo, ".claude", "worktrees", "wtc_default");
		const {code, stdout} = run(mainRepo, JSON.stringify({worktree_path: wt}));
		assert.strictEqual(code, 0, "a payload without base_ref still provisions from origin/main");
		assert.strictEqual(stdout.trim(), wt);
		assert.isTrue(existsSync(wt));
	});

	it("parses correctly without jq (grep/sed fallback) — the same result", () => {
		// Force the jq-less branch deterministically across OSes: run under `env -i` with a
		// PATH pointing at a bindir that has ONLY the tools the parse needs (bash + coreutils),
		// and crucially NO jq. The script parses under this PATH before it prepends the standard
		// toolchain dirs, so `command -v jq` genuinely misses and the grep/sed fallback runs.
		const bindir = mkdtempSync(join(tmpdir(), "wtc-nojq-bin-"));
		const which = (tool: string) =>
			execFileSync("bash", ["-lc", `command -v ${tool}`], {encoding: "utf8"}).trim();
		for (const tool of ["bash", "cat", "grep", "sed", "head", "git", "printf"]) {
			try {
				symlinkSync(which(tool), join(bindir, tool));
			} catch {
				/* printf is often a shell builtin with no binary — the parse still works without it */
			}
		}
		const wt = join(mainRepo, ".claude", "worktrees", "wtc_nojq");
		const payload = JSON.stringify({worktree_path: wt, base_ref: "main"});
		let stdout = "";
		let code = 0;
		try {
			stdout = execFileSync("bash", [SCRIPT], {
				cwd: mainRepo,
				input: payload,
				encoding: "utf8",
				// env -i: PATH=bindir ONLY (jq-free — no /usr/bin, which carries jq on Linux) so
				// the parse deterministically takes the fallback; the script re-adds the standard
				// toolchain dirs AFTER parsing, so git still resolves for `worktree add`.
				env: {PATH: bindir, HOME: mainRepo},
			});
		} catch (e) {
			const err = e as {status?: number; stdout?: string};
			code = err.status ?? 1;
			stdout = err.stdout ?? "";
		} finally {
			rmSync(bindir, {recursive: true, force: true});
		}
		assert.strictEqual(code, 0);
		assert.strictEqual(stdout.trim(), wt, "the jq-less fallback must extract the same path");
		assert.isTrue(existsSync(wt));
	});

	it("fail-closes (non-zero) when worktree_path is absent — never a silent no-op", () => {
		const {code} = run(mainRepo, JSON.stringify({base_ref: "main"}));
		assert.notStrictEqual(code, 0, "a payload with no worktree_path must be rejected");
	});

	it("fail-closes (non-zero) when git worktree add fails (bad base_ref)", () => {
		const wt = join(mainRepo, ".claude", "worktrees", "wtc_badref");
		const {code} = run(mainRepo, JSON.stringify({worktree_path: wt, base_ref: "no-such-ref"}));
		assert.notStrictEqual(code, 0, "a non-existent base_ref must fail-close, blocking creation");
		assert.isFalse(existsSync(wt), "no partial worktree should be left behind");
	});
});
