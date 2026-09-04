/**
 * `withConcurrencyRecovery`'s decision to retry, over outcomes the spawner cannot produce.
 *
 * The command is the function's own parameter, so the outcomes are handed to it directly rather than
 * scripted through `fakeShell`, which maps every answer onto a child that exits — it has no way to
 * express the one this file is about, a run killed at its timeout with stderr already captured
 * (#7408). The spawner is still provided, and it is an assertion in its own right: a recovery round
 * spawns `git worktree prune`, so a scripted-empty `calls` array is the proof no round ran.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell} from "../fakes.test-support.ts";
import type {ChildOutcome} from "../io/exec.ts";
import {RECOVERY_ATTEMPTS} from "./worktree-create.ts";
import {
	describeOutcome,
	GIT_TIMEOUT_SECONDS,
	withConcurrencyRecovery,
} from "./worktree-create-verb.ts";

const PLACEHOLDER_HEAD = "fatal: bad object worktrees/agent-7f2/HEAD\n";
const INCOMPLETE_ADMIN_DIR = "fatal: failed to read .git/worktrees/agent-7f2/commondir\n";

const ran = (
	stderr: string,
	over: Partial<Extract<ChildOutcome, {_tag: "Ran"}>>,
): ChildOutcome => ({
	_tag: "Ran",
	exitCode: 1,
	timedOut: false,
	stdout: new Uint8Array(),
	stderr: new TextEncoder().encode(stderr),
	truncated: false,
	...over,
});

const timedOut = (stderr: string): ChildOutcome => ran(stderr, {exitCode: null, timedOut: true});

const succeeded: ChildOutcome = ran("", {exitCode: 0});

/** Replay one outcome per attempt, counting the attempts and holding the last after they run out. */
const scripted = (outcomes: ReadonlyArray<ChildOutcome>) => {
	const seen: ChildOutcome[] = [];
	const command = Effect.sync(() => {
		const next = outcomes[Math.min(seen.length, outcomes.length - 1)] as ChildOutcome;
		seen.push(next);
		return next;
	});
	return {
		command,
		get attempts() {
			return seen.length;
		},
	};
};

const recover = (outcomes: ReadonlyArray<ChildOutcome>) => {
	const script = scripted(outcomes);
	const shell = fakeShell([]);
	return Effect.runPromise(
		Effect.provide(withConcurrencyRecovery(script.command, "/repo", {}), shell.layer),
	).then((attempted) => ({attempted, attempts: script.attempts, spawned: shell.calls}));
};

describe("a timed-out git command", () => {
	it.each([
		["PlaceholderHead", PLACEHOLDER_HEAD],
		["IncompleteAdminDir", INCOMPLETE_ADMIN_DIR],
	])("is refused on its first attempt though its stderr matches %s", async (_arm, stderr) => {
		const {attempted, attempts, spawned} = await recover([timedOut(stderr)]);
		expect(attempts).toBe(1);
		expect(attempted.attempts).toBe(1);
		expect(attempted.exhausted).toBeNull();
		expect(spawned).toEqual([]);
	});

	it("is refused as the timeout it was, not as the stderr it captured", () => {
		expect(describeOutcome(timedOut(PLACEHOLDER_HEAD))).toBe(
			`git did not finish within ${GIT_TIMEOUT_SECONDS}s`,
		);
	});
});

describe("a fast-failing git command", () => {
	it.each([
		["PlaceholderHead", PLACEHOLDER_HEAD],
		["IncompleteAdminDir", INCOMPLETE_ADMIN_DIR],
	])("is still pruned and re-attempted through a %s window", async (_arm, stderr) => {
		const {attempted, attempts, spawned} = await recover([ran(stderr, {}), succeeded]);
		expect(attempts).toBe(2);
		expect(attempted.attempts).toBe(2);
		expect(attempted.exhausted).toBeNull();
		expect(spawned).toEqual(["git worktree prune"]);
	});

	it("still exhausts the bounded recovery when the window never closes", async () => {
		const {attempted, attempts} = await recover([ran(PLACEHOLDER_HEAD, {})]);
		expect(attempts).toBe(RECOVERY_ATTEMPTS);
		expect(attempted.exhausted).toBe("PlaceholderHead");
	}, 20_000);

	it("refuses an unrecognised diagnostic on its first attempt", async () => {
		const {attempts, spawned} = await recover([ran("fatal: could not read Username\n", {})]);
		expect(attempts).toBe(1);
		expect(spawned).toEqual([]);
	});
});
