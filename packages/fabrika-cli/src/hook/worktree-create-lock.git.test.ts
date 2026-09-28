/**
 * `hook worktree-create` run as the harness runs it — one process per spawn, several at once,
 * against one throwaway clone — with real git for the fetch and the add.
 *
 * The install is a stand-in: a `post-checkout` in the clone that writes `node_modules/.pnpm` and
 * sleeps, so the test can see whether the installs of concurrent spawns overlapped. Each stand-in
 * notes how many installs were in flight while it ran; a count above one is an overlap, which only
 * happens if the install runs outside the creation lock.
 *
 * `worktree-concurrency.git.test.ts` beside this file models the git sequence in-process; this file
 * is the lock, which only separate processes can contend for.
 * @ruling https://github.com/kamp-us/phoenix/issues/7057
 */
import {spawn, spawnSync} from "node:child_process";
import {chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from "node:fs";
import {hostname} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, describe, expect, it} from "vitest";
import {lockDirFor, stampOf} from "./creation-lock.ts";
import {gitSync, openClone, removeClones} from "./throwaway-clone.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const SPAWNS = 6;
const INSTALL_SECONDS = 3;

afterAll(removeClones);

interface Created {
	readonly name: string;
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** One hook process, fed the envelope the harness would send, run from outside the clone. */
const createOne = (clone: string, cwd: string, name: string): Promise<Created> =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, "hook", "worktree-create"], {
			cwd,
			env: {PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? ""},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => resolve({name, code, stdout, stderr}));
		child.stdin.end(
			JSON.stringify({
				session_id: "80f40b22-8788-40d0-ac1c-08ab808d6086",
				transcript_path: "/tmp/transcript.jsonl",
				cwd: clone,
				hook_event_name: "WorktreeCreate",
				name,
			}),
		);
	});

/**
 * A clone whose `post-checkout` is the stand-in install. Its paths are literal because the hook's
 * children inherit only an allowlisted environment.
 */
const cloneWithStandIn = (): {clone: string; scratch: string; seen: string} => {
	const {clone, scratch} = openClone();
	mkdirSync(scratch, {recursive: true});
	const hooks = join(clone, ".git", "hooks");
	const inflight = join(scratch, "inflight");
	const seen = join(scratch, "seen");
	mkdirSync(inflight, {recursive: true});
	writeFileSync(seen, "");
	writeFileSync(
		join(hooks, "post-checkout"),
		[
			"#!/bin/sh",
			"mkdir -p node_modules/.pnpm",
			`touch "${inflight}/$$"`,
			`sleep ${INSTALL_SECONDS}`,
			`ls "${inflight}" | wc -l >> "${seen}"`,
			`rm -f "${inflight}/$$"`,
			"",
		].join("\n"),
	);
	chmodSync(join(hooks, "post-checkout"), 0o755);
	// Local config outranks any global `core.hooksPath` the developer's HOME carries.
	gitSync(clone, "config", "core.hooksPath", hooks);
	return {clone, scratch, seen};
};

const registered = (clone: string): string => gitSync(clone, "worktree", "list", "--porcelain");

describe("hook worktree-create under concurrent spawns", () => {
	it(`provisions all ${SPAWNS} spawns started at once, and their installs overlap`, async () => {
		const {clone, scratch, seen} = cloneWithStandIn();

		const results = await Promise.all(
			Array.from({length: SPAWNS}, (_, i) => createOne(clone, scratch, `lane-${i}`)),
		);

		// As one object, so a red prints every loser's own stderr.
		expect(results.filter((r) => r.code !== 0)).toEqual([]);
		const listed = registered(clone);
		// The hook plans at the primary tree git names, and git resolves symlinks (macOS's tmpdir is one).
		const primary = realpathSync(clone);
		for (const r of results) {
			const path = join(primary, ".claude", "worktrees", r.name);
			expect(r.stdout.trim()).toBe(path);
			expect(listed).toContain(path);
		}
		const counts = readFileSync(seen, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map(Number);
		expect(counts).toHaveLength(SPAWNS);
		expect(Math.max(...counts)).toBeGreaterThan(1);
		expect(() => readFileSync(join(lockDirFor(join(clone, ".git")), "holder"))).toThrow();
	}, 120_000);

	it("is not blocked by a lock a dead process left behind", async () => {
		const {clone, scratch} = cloneWithStandIn();
		const exited = spawnSync(process.execPath, ["-e", ""]);
		expect(exited.status).toBe(0);
		const lockDir = lockDirFor(join(clone, ".git"));
		mkdirSync(lockDir, {recursive: true});
		writeFileSync(
			join(lockDir, "holder"),
			stampOf({id: "dead-holder", pid: exited.pid ?? 0, host: hostname(), at: Date.now()}),
		);

		const created = await createOne(clone, scratch, "after-the-dead");

		expect(created).toMatchObject({code: 0});
		expect(registered(clone)).toContain(join(clone, ".claude", "worktrees", "after-the-dead"));
		// The sweep ran for real first, and its own summary line is quoted rather than re-derived.
		expect(created.stderr).toContain("reaped before provisioning — fabrika build reap: ");
	}, 120_000);
});
