import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Schedule, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {bundleZipFor} from "./fixtures.ts";
import {
	allArgBuilders,
	makeRunEvidenceIoLive,
	type RepoResolutionError,
	RunEvidenceIo,
} from "./github.ts";
import {classifyBundle} from "./run-evidence.ts";

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

const HEAD = "05de8f09aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = 30144746535;
const ARTIFACT_ID = 8615655601;
const enc = new TextEncoder();

interface Reply {
	readonly stdout: Uint8Array | string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

const bytesOf = (value: Uint8Array | string): Uint8Array =>
	typeof value === "string" ? enc.encode(value) : value;

/** A `ChildProcessSpawner` answering `gh api` from a REST-path fixture map, bytes included. */
const mockSpawner = (
	replies: Record<string, Reply>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const path = (args.find((a) => a.startsWith("repos/")) ?? "").replace(/\?.*$/, "");
				const reply = replies[path];
				const stdout = reply === undefined ? new Uint8Array(0) : bytesOf(reply.stdout);
				const exitCode = reply?.exitCode ?? (reply === undefined ? 1 : 0);
				const stderr =
					reply?.stderr ?? (reply === undefined ? `gh: Not Found (HTTP 404) ${path}` : "");
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([stdout]),
					stderr: Stream.fromIterable([enc.encode(stderr)]),
					all: Stream.fromIterable([stdout]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

// One immediate retry: enough to exercise the transient path without a real backoff delay.
const TEST_SCHEDULE = Schedule.recurs(1);

const provide = <A, E>(
	effect: Effect.Effect<A, E, RunEvidenceIo>,
	replies: Record<string, Reply>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(
		Effect.provide(makeRunEvidenceIoLive(TEST_SCHEDULE).pipe(Layer.provide(mockSpawner(replies)))),
	);

const path = (suffix: string) => `repos/${PINNED_REPO}/${suffix}`;
const WORKFLOWS = path("actions/workflows");
const RUNS = path("actions/runs");
const ARTIFACTS = path(`actions/runs/${RUN_ID}/artifacts`);
const ZIP = path(`actions/artifacts/${ARTIFACT_ID}/zip`);

const producerDefined = {stdout: JSON.stringify([{workflows: [{name: "run-evidence"}]}])};

const runsAtHead = (
	over: {status?: string; conclusion?: string | null; headSha?: string} = {},
) => ({
	stdout: JSON.stringify([
		{
			workflow_runs: [
				{
					id: RUN_ID,
					name: "run-evidence",
					head_sha: over.headSha ?? HEAD,
					status: over.status ?? "completed",
					conclusion: over.conclusion ?? "success",
					created_at: "2026-07-25T04:57:44Z",
				},
			],
		},
	]),
});

const artifactListed = {
	stdout: JSON.stringify([{artifacts: [{id: ARTIFACT_ID, name: "run-evidence", expired: false}]}]),
};

const readingFor = (replies: Record<string, Reply>) =>
	provide(
		Effect.flatMap(RunEvidenceIo, (io) => io.probe(HEAD)),
		replies,
	).pipe(Effect.map(classifyBundle));

describe("the gh boundary never uses --silent", () => {
	// `gh api --silent` discards the response body: the artifact download "succeeds" with 0 bytes and
	// the missing manifest reads as a missing bundle. Asserted here so it cannot be reintroduced.
	it("no arg list this boundary builds carries --silent", () => {
		for (const args of allArgBuilders(PINNED_REPO)) {
			assert.notInclude(args, "--silent");
		}
	});

	it("the runs query pins head_sha — the binding filter (ADR 0056 §2)", () => {
		const runsQuery = allArgBuilders(PINNED_REPO).find((args) =>
			args.some((a) => a.includes("actions/runs?")),
		);
		assert.isDefined(runsQuery);
		assert.isTrue(runsQuery?.some((a) => a.includes("head_sha=")));
	});
});

describe("probe → classify, end to end over the real decode path", () => {
	it("PRESENT: a published, head-bound archive resolves present with its numbers", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead(),
				[ARTIFACTS]: artifactListed,
				[ZIP]: {stdout: bundleZipFor(HEAD)},
			});
			assert.strictEqual(reading.state, "present");
			assert.strictEqual(reading.evidence.runId, RUN_ID);
			assert.strictEqual(reading.evidence.artifactId, ARTIFACT_ID);
			assert.strictEqual(reading.manifest?.tests.total, 2362);
		}).pipe(Effect.runPromise));

	it("PENDING: a run in flight at the head is pending, not absent", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead({status: "in_progress", conclusion: null}),
			});
			assert.strictEqual(reading.state, "pending");
			assert.strictEqual(reading.reason, "run-not-completed");
		}).pipe(Effect.runPromise));

	it("PENDING: no producer run at the head yet is pending, not absent (the #3913 instance)", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: {stdout: JSON.stringify([{workflow_runs: []}])},
			});
			assert.strictEqual(reading.state, "pending");
			assert.strictEqual(reading.reason, "no-run-at-head-yet");
			assert.strictEqual(reading.evidence.runsAtHead, 0);
		}).pipe(Effect.runPromise));

	it("PENDING: a run bound to an EARLIER push is not evidence for this head", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead({headSha: "c7e6549cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}),
			});
			assert.strictEqual(reading.state, "pending");
			assert.strictEqual(reading.reason, "no-run-at-head-yet");
		}).pipe(Effect.runPromise));

	it("ABSENT: a completed run that published no artifact", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead(),
				[ARTIFACTS]: {stdout: JSON.stringify([{artifacts: []}])},
			});
			assert.strictEqual(reading.state, "absent");
			assert.strictEqual(reading.reason, "run-completed-without-artifact");
		}).pipe(Effect.runPromise));

	it("ABSENT: a repo that defines no producer workflow", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: {stdout: JSON.stringify([{workflows: [{name: "ci"}]}])},
			});
			assert.strictEqual(reading.state, "absent");
			assert.strictEqual(reading.reason, "no-producer-workflow");
		}).pipe(Effect.runPromise));

	it("UNKNOWN: a 503 on the runs read is unknown, and names the captured cause", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: {stdout: "", exitCode: 1, stderr: "gh: Server Error (HTTP 503)"},
			});
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, "runs-unreadable");
			assert.include(reading.detail, "HTTP 503");
			assert.strictEqual(reading.evidence.runsAtHead, null);
		}).pipe(Effect.runPromise));

	it("UNKNOWN: a 503 error body served in place of the archive (the #3693 payload)", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead(),
				[ARTIFACTS]: artifactListed,
				[ZIP]: {stdout: JSON.stringify({message: "Server Error"})},
			});
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, "archive-unreadable");
			assert.include(reading.detail, "not a ZIP archive");
		}).pipe(Effect.runPromise));

	it("UNKNOWN: an EMPTY artifact download — the `--silent` 0-byte failure mode", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead(),
				[ARTIFACTS]: artifactListed,
				[ZIP]: {stdout: new Uint8Array(0)},
			});
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, "archive-unreadable");
		}).pipe(Effect.runPromise));

	it("UNKNOWN: a non-conforming runs response (wrong shape) is a failed read, not absence", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: {stdout: JSON.stringify({message: "Not Found"})},
			});
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, "runs-unreadable");
			assert.include(reading.detail, "did not conform");
		}).pipe(Effect.runPromise));

	it("UNKNOWN: a stale manifest whose commit is not this head", () =>
		Effect.gen(function* () {
			const reading = yield* readingFor({
				[WORKFLOWS]: producerDefined,
				[RUNS]: runsAtHead(),
				[ARTIFACTS]: artifactListed,
				[ZIP]: {stdout: bundleZipFor("c7e6549cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")},
			});
			assert.strictEqual(reading.state, "unknown");
			assert.strictEqual(reading.reason, "manifest-commit-mismatch");
		}).pipe(Effect.runPromise));
});

describe("headSha — the live head the bundle must be bound to", () => {
	it("reads .head.sha off the pulls endpoint", () =>
		provide(
			Effect.flatMap(RunEvidenceIo, (io) => io.headSha(3951)),
			{[path("pulls/3951")]: {stdout: JSON.stringify({head: {sha: HEAD}})}},
		).pipe(
			Effect.tap((sha) => Effect.sync(() => assert.strictEqual(sha, HEAD))),
			Effect.runPromise,
		));
});
