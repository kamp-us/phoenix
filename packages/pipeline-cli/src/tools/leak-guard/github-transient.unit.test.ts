/**
 * `leak-guard scan-pr` transient-GH resilience (#3710). Two contracts:
 *
 *   1. `isTransientGh` — the pure discrimination: a 5xx/429 or a transport reset is transient
 *      (retry); a 4xx (auth/not-found) is a REAL terminal answer (fail fast, never masked).
 *   2. `makePrCommentsLive` — the boundary rides out a transient blip with bounded backoff, and
 *      a read still transient past the budget resolves to the typed `UpstreamUnavailableError`
 *      (the third outcome), while a 4xx fails fast as a plain `GhCommandError` (unchanged).
 *
 * The retry schedule is injected as a zero-delay `Schedule.recurs` so the tests exercise the real
 * retry path without real time (no TestClock dance): `recurs` has no delay, so it completes inline.
 */
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Cause, Effect, Layer, Schedule, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {
	GhCommandError,
	isTransientGh,
	makePrCommentsLive,
	PrComments,
	UpstreamUnavailableError,
} from "./github.ts";

const PINNED_REPO = "kamp-us/phoenix";
let savedEnv: string | undefined;
beforeAll(() => {
	savedEnv = process.env.CLAUDE_PIPELINE_REPO;
	process.env.CLAUDE_PIPELINE_REPO = PINNED_REPO;
});
afterAll(() => {
	if (savedEnv === undefined) delete process.env.CLAUDE_PIPELINE_REPO;
	else process.env.CLAUDE_PIPELINE_REPO = savedEnv;
});

describe("isTransientGh — 5xx/429/transport is transient, 4xx is terminal (#3710)", () => {
	const gh = (exitCode: number, stderr: string) =>
		new GhCommandError({args: ["api", "repos/x/y/pulls/1/comments"], exitCode, stderr});

	it("retries the 5xx gateway/overload family", () => {
		for (const status of [500, 502, 503, 504]) {
			assert.isTrue(
				isTransientGh(gh(1, `gh: HTTP ${status}: Service Unavailable`)),
				`HTTP ${status}`,
			);
		}
	});

	it("retries a 429 rate-limit and a bare transport reset (exitCode -1)", () => {
		assert.isTrue(isTransientGh(gh(1, "gh: HTTP 429: Too Many Requests")));
		assert.isTrue(isTransientGh(gh(-1, "spawn failed: connection reset by peer")));
		assert.isTrue(isTransientGh(gh(1, "error: read tcp: ECONNRESET")));
		assert.isTrue(isTransientGh(gh(1, "dial tcp: i/o timeout")));
	});

	it("does NOT retry a 4xx — auth/not-found is a real terminal answer", () => {
		for (const status of [401, 403, 404, 422]) {
			assert.isFalse(isTransientGh(gh(1, `gh: HTTP ${status}: Not Found`)), `HTTP ${status}`);
		}
	});

	it("does NOT match a 5xx-looking number that is not an HTTP status (no false positive)", () => {
		assert.isFalse(isTransientGh(gh(1, "gh: issue 503 was closed")));
	});
});

// ── boundary retry behavior over a stateful mock spawner ────────────────────────────────────

interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

const enc = new TextEncoder();

const handleFor = (canned: Canned) =>
	ChildProcessSpawner.makeHandle({
		pid: ChildProcessSpawner.ProcessId(1),
		stdin: Sink.drain,
		stdout: Stream.fromIterable([enc.encode(canned.stdout)]),
		stderr: Stream.fromIterable([enc.encode(canned.stderr ?? "")]),
		all: Stream.fromIterable([enc.encode(canned.stdout)]),
		exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(canned.exitCode ?? 0)),
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	});

const P = "repos/kamp-us/phoenix";
const PR = 3710;

/**
 * A spawner answering each `gh api GET <path>` from a per-path SEQUENCE of canned responses (the
 * last entry repeats once its queue drains), tracking per-path call counts so a test can assert
 * how many times a path was hit — the proof a 4xx is NOT retried. The whole fetch is re-run on
 * retry, so the issue path is set to a repeating 200 while the review path carries the sequence.
 */
const sequenceSpawner = (sequences: Record<string, ReadonlyArray<Canned>>) => {
	const calls: Record<string, number> = {};
	const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const rawPath =
					args.find((a) => a.startsWith("repos/")) ??
					(args[0] === "api" ? (args[1] ?? "") : args.slice(0, 2).join(" "));
				const path = rawPath.replace(/\?.*$/, "");
				const seq = sequences[`GET ${path}`];
				if (seq === undefined) {
					return handleFor({stdout: "", exitCode: 1, stderr: `not found: GET ${path}`});
				}
				const i = calls[path] ?? 0;
				calls[path] = i + 1;
				return handleFor(seq[Math.min(i, seq.length - 1)] ?? {stdout: ""});
			}),
		),
	);
	return {layer, calls};
};

const OK_EMPTY = {stdout: "[]"};
const OK_ISSUE = {stdout: JSON.stringify([{id: 1, body: "review-code: PASS @ abc1234"}])};
const OK_REVIEW = {stdout: JSON.stringify([{id: 2, body: "looks good"}])};
const GH_503 = {stdout: "", exitCode: 1, stderr: "gh: HTTP 503: Service Unavailable"};
const GH_404 = {stdout: "", exitCode: 1, stderr: "gh: HTTP 404: Not Found"};

// Zero-delay budget so the real retry path runs without real time (recurs has no backoff delay).
const FAST_SCHEDULE = Schedule.recurs(4);

const runFetch = (sequences: Record<string, ReadonlyArray<Canned>>) => {
	const {layer, calls} = sequenceSpawner(sequences);
	const exit = Effect.runPromiseExit(
		PrComments.pipe(
			Effect.flatMap((svc) => svc.fetch(PR)),
			Effect.provide(makePrCommentsLive(FAST_SCHEDULE).pipe(Layer.provide(layer))),
		),
	);
	return {exit, calls};
};

describe("makePrCommentsLive — transient retry + unknown outcome (#3710)", () => {
	it("rides out a 503-then-200 on the review-comments read (retry succeeds)", async () => {
		const {exit, calls} = runFetch({
			[`GET ${P}/issues/${PR}/comments`]: [OK_ISSUE],
			[`GET ${P}/pulls/${PR}/comments`]: [GH_503, OK_REVIEW],
		});
		const result = await exit;
		assert.strictEqual(result._tag, "Success");
		if (result._tag === "Success") {
			assert.deepStrictEqual(
				result.value.map((c) => ({id: c.id, kind: c.kind})),
				[
					{id: 1, kind: "issue"},
					{id: 2, kind: "review"},
				],
			);
		}
		// The review path was hit twice: the 503, then the 200 on retry.
		assert.strictEqual(calls[`${P}/pulls/${PR}/comments`], 2);
	});

	it("a sustained 5xx resolves to UpstreamUnavailableError (the third outcome, gate blocks)", async () => {
		const {exit} = runFetch({
			[`GET ${P}/issues/${PR}/comments`]: [OK_ISSUE],
			[`GET ${P}/pulls/${PR}/comments`]: [GH_503],
		});
		const result = await exit;
		assert.strictEqual(result._tag, "Failure");
		if (result._tag === "Failure") {
			const error = Cause.squash(result.cause);
			assert.isTrue(
				error instanceof UpstreamUnavailableError,
				"a sustained 5xx must resolve to the typed unknown outcome, not a raw GhCommandError",
			);
			if (error instanceof UpstreamUnavailableError) {
				assert.strictEqual(error.pr, PR);
				assert.strictEqual(error.attempts, 5);
				assert.include(error.detail, "503");
			}
		}
	});

	it("a 4xx (404) fails FAST as a terminal GhCommandError — never retried, never masked", async () => {
		const {exit, calls} = runFetch({
			[`GET ${P}/issues/${PR}/comments`]: [OK_EMPTY],
			[`GET ${P}/pulls/${PR}/comments`]: [GH_404],
		});
		const result = await exit;
		assert.strictEqual(result._tag, "Failure");
		if (result._tag === "Failure") {
			const error = Cause.squash(result.cause);
			assert.isTrue(
				error instanceof GhCommandError,
				"a 404 stays a terminal GhCommandError, not the transient unknown outcome",
			);
		}
		// Hit exactly once — a terminal 4xx is not re-driven by the retry.
		assert.strictEqual(calls[`${P}/pulls/${PR}/comments`], 1);
	});
});
