import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, STALE_HEAD, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runEnqueue} from "./enqueue-verb.ts";
import {ENV, HEAD, OTHER_HEAD, pull, timeline} from "./fixtures.test-support.ts";
import {ADDED} from "./queue.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const ARM = /^gh pr merge 4321 --repo o\/r --auto$/;
const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;

const options = {pr: 4321, sha: HEAD, repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runEnqueue({...options, ...overrides}), fakeShell(script).layer),
	);

describe("runEnqueue", () => {
	it("arms with NO merge-method flag and reports the visible entry", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[ARM, okOut("")],
			[TIMELINE, timeline({event: ADDED, at: "2026-08-08T10:00:00Z"})],
		]);
		const out = await Effect.runPromise(Effect.provide(runEnqueue(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`enqueued\t${HEAD}\tqueued\n`);
		expect(shell.calls).toContain("gh pr merge 4321 --repo o/r --auto");
		expect(shell.calls.some((line) => /--squash|--merge|--rebase/.test(line))).toBe(false);
	});

	it("reports `settling` when the entry has not surfaced — the normal race, not a failure", async () => {
		const out = await run([
			[PULL, pull()],
			[ARM, okOut("")],
			[TIMELINE, timeline()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`enqueued\t${HEAD}\tsettling\n`);
	});

	it("refuses a moved head on 12 — arming a tree nobody verified", async () => {
		const shell = fakeShell([[PULL, pull({head: OTHER_HEAD})]]);
		const out = await Effect.runPromise(Effect.provide(runEnqueue(options), shell.layer));
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((line) => line.startsWith("gh pr merge"))).toBe(false);
	});

	it("refuses an already-merged PR on 7 — an idempotent success is `ship scope`'s answer", async () => {
		const out = await run([[PULL, pull({merged: true, state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("ship enqueue: PR #4321 is merged — nothing to enqueue.");
	});

	it("refuses on 8 when the arm fails, quoting the error so the jam is discriminable", async () => {
		const out = await run([
			[PULL, pull()],
			[ARM, errOut("Pull request is in unstable status")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('the arm failed: "Pull request is in unstable status"');
		expect(out.stderr.at(-1)).toContain("disarm before stopping");
	});

	// Probed live: GitHub ACCEPTS the arm on a conflicted PR under a queue-governed base and parks the
	// intent, so nothing but this precondition stands between `dirty` and a parked intent reported as
	// a healthy enqueue.
	it("refuses on 11 when mergeability stays indefinite — an unknown read is never green", async () => {
		const shell = fakeShell([[PULL, pull({mergeable: null, mergeableState: "unknown"})]]);
		const out = await Effect.runPromise(Effect.provide(runEnqueue(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship enqueue: #4321's mergeable_state is still indefinite after 3 polls — mergeability is UNKNOWN, never green; nothing was armed.",
		);
		expect(shell.calls.some((line) => line.startsWith("gh pr merge"))).toBe(false);
	}, 20_000);

	it("arms on a definite mergeable_state, whatever that state says", async () => {
		const shell = fakeShell([
			[PULL, pull({mergeable: false, mergeableState: "dirty"})],
			[ARM, okOut("")],
			[TIMELINE, timeline()],
		]);
		const out = await Effect.runPromise(Effect.provide(runEnqueue(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls).toContain("gh pr merge 4321 --repo o/r --auto");
	});

	it("refuses on 11 when the mergeability read itself fails — nothing was armed", async () => {
		const shell = fakeShell([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		const out = await Effect.runPromise(Effect.provide(runEnqueue(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((line) => line.startsWith("gh pr merge"))).toBe(false);
	});

	it("refuses on 8 when the confirming read-back fails", async () => {
		const out = await run([
			[PULL, pull()],
			[ARM, okOut("")],
			[TIMELINE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the confirming read-back failed");
	});
});
