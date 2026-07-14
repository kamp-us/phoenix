import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {PrComments, PrCommentsLive, type RepoResolutionError} from "./github.ts";
import {scanPrComments} from "./scan-pr.ts";

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

interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}
type Response = string | Canned;

const enc = new TextEncoder();
const normalize = (response: Response): Canned =>
	typeof response === "string" ? {stdout: response} : response;

/** A `ChildProcessSpawner` answering `gh api` from a `GET <path>` fixture map (no `-X` here — reads only). */
const mockSpawner = (
	responses: Record<string, Response>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const rawPath =
					args.find((a) => a.startsWith("repos/")) ??
					(args[0] === "api" ? (args[1] ?? "") : args.slice(0, 2).join(" "));
				const path = rawPath.replace(/\?.*$/, "");
				const key = `GET ${path}`;
				const canned =
					key in responses
						? normalize(responses[key]!)
						: {stdout: "", exitCode: 1, stderr: `not found: ${key}`};
				return ChildProcessSpawner.makeHandle({
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
			}),
		),
	);

const provide = <A, E>(
	effect: Effect.Effect<A, E, PrComments>,
	responses: Record<string, Response>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(PrCommentsLive.pipe(Layer.provide(mockSpawner(responses)))));

const PR = 3018;
const P = `repos/kamp-us/phoenix`;
const ISSUE = `GET ${P}/issues/${PR}/comments`;
const REVIEW = `GET ${P}/pulls/${PR}/comments`;

describe("PrComments.fetch — read a PR's issue + review comments over a mock gh spawner (#3019)", () => {
	it.effect("fetches BOTH surfaces and tags each comment's kind", () =>
		Effect.gen(function* () {
			const comments = yield* (yield* PrComments).fetch(PR);
			assert.deepStrictEqual(
				comments.map((c) => ({id: c.id, kind: c.kind})),
				[
					{id: 1, kind: "issue"},
					{id: 2, kind: "review"},
				],
			);
		}).pipe((effect) =>
			provide(effect, {
				[ISSUE]: JSON.stringify([{id: 1, body: "review-doc: PASS @ abc1234"}]),
				[REVIEW]: JSON.stringify([{id: 2, body: "nit here"}]),
			}),
		),
	);

	it.effect(
		"a leaked verdict comment (the #3018 bypass) is found by scanPrComments off the fetch",
		() =>
			Effect.gen(function* () {
				const comments = yield* (yield* PrComments).fetch(PR);
				const leaks = scanPrComments(comments);
				assert.strictEqual(leaks.length, 1);
				assert.strictEqual(leaks[0]?.id, 5);
				assert.strictEqual(leaks[0]?.kind, "issue");
				assert.include(leaks[0]?.leak.matched, "/private/tmp/review-doc-verdict.E2CYtu");
			}).pipe((effect) =>
				provide(effect, {
					[ISSUE]: JSON.stringify([
						{id: 5, body: "review-doc: FAIL — see /private/tmp/review-doc-verdict.E2CYtu"},
					]),
					[REVIEW]: JSON.stringify([]),
				}),
			),
	);

	it.effect("a null-body comment decodes to '' and is clean, not a crash", () =>
		Effect.gen(function* () {
			const comments = yield* (yield* PrComments).fetch(PR);
			assert.deepStrictEqual(scanPrComments(comments), []);
		}).pipe((effect) =>
			provide(effect, {
				[ISSUE]: JSON.stringify([{id: 9, body: null}]),
				[REVIEW]: JSON.stringify([]),
			}),
		),
	);
});
