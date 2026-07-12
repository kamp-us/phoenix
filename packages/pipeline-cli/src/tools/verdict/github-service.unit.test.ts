import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Github, GithubLive, type RepoResolutionError, VerdictInputError} from "./github.ts";

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

const methodOf = (args: ReadonlyArray<string>): string => {
	const i = args.indexOf("-X");
	return i >= 0 ? (args[i + 1] ?? "GET") : "GET";
};

/** A `ChildProcessSpawner` answering `gh api`/`gh repo`/`gh user` from a `${method} ${key}` fixture map. */
const mockSpawner = (
	responses: Record<string, Response>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				// route on the REST path when present, else on the `gh <sub> <verb>` shape (user/repo)
				const rawPath =
					args.find((a) => a.startsWith("repos/")) ??
					(args[0] === "api" ? (args[1] ?? "") : args.slice(0, 2).join(" "));
				const path = rawPath.replace(/\?.*$/, "");
				const key = `${methodOf(args)} ${path}`;
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
	effect: Effect.Effect<A, E, Github>,
	responses: Record<string, Response>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses)))));

const PR = 500;
const P = `repos/kamp-us/phoenix`;
const HEAD = "abc1234def5678";
const OLD = "0000000aaaa1111";

const comment = (over: {
	readonly id: number;
	readonly login: string;
	readonly body: string;
	readonly at?: string;
}) =>
	({
		id: over.id,
		created_at: over.at ?? "2026-07-11T00:00:00Z",
		user: {login: over.login},
		body: over.body,
	}) as const;

describe("Github.read — resolve a PR's SHA-bound verdict over a mock gh spawner", () => {
	it.effect("current-head PASS from a write+ author → satisfied", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).read(PR, "doc", "PASS");
			assert.strictEqual(result.outcome._tag, "current");
			assert.isTrue(result.satisfied);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/pulls/${PR}`]: HEAD,
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 1, login: "usirin", body: `review-doc: PASS @ ${HEAD} — merge-ready`}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "admin",
			}),
		),
	);

	it.effect("a stale-sha PASS → not satisfied (unverified)", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).read(PR, "doc", "PASS");
			assert.strictEqual(result.outcome._tag, "stale");
			assert.isFalse(result.satisfied);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/pulls/${PR}`]: HEAD,
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 1, login: "usirin", body: `review-doc: PASS @ ${OLD} — merge-ready`}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect("a forged PASS from a non-collaborator is invisible → none", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).read(PR, "doc", "PASS");
			assert.strictEqual(result.outcome._tag, "none");
			assert.isFalse(result.satisfied);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/pulls/${PR}`]: HEAD,
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 1, login: "attacker", body: `review-doc: PASS @ ${HEAD} — merge-ready`}),
				]),
				[`GET ${P}/collaborators/attacker/permission`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Not Found",
				},
			}),
		),
	);

	it.effect("a --head override binds against the supplied head, not the PR's live head", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).read(PR, "skill", "PASS", HEAD);
			assert.strictEqual(result.outcome._tag, "current");
			assert.strictEqual(result.headSha, HEAD);
		}).pipe((effect) =>
			provide(effect, {
				// no pulls fixture: a live-head lookup would 404 — the override must be used instead
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 1, login: "usirin", body: `review-skill: PASS @ ${HEAD} — merge-ready`}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "maintain",
			}),
		),
	);
});

describe("Github.post — the ADR-0058 rule-2 upsert over a mock gh spawner", () => {
	const BODY = `review-doc: PASS @ ${HEAD} — merge-ready\n\nReviewed-head: @ ${HEAD}`;

	it.effect("no prior marker → POST a fresh verdict comment", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).post(PR, "doc", BODY);
			assert.deepStrictEqual(result, {_tag: "posted", commentId: 999});
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 1, login: "someone", body: "just chatter"}),
				]),
				[`POST ${P}/issues/${PR}/comments`]: "999",
			}),
		),
	);

	it.effect("our own prior marker exists → PATCH it (upsert, not append)", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).post(PR, "doc", BODY);
			assert.deepStrictEqual(result, {_tag: "patched", commentId: 42});
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 42, login: "usirin", body: `review-doc: FAIL @ ${OLD} — changes-requested`}),
				]),
				[`PATCH ${P}/issues/comments/42`]: "42",
			}),
		),
	);

	it.effect("only ANOTHER author's marker exists → POST ours, never PATCH theirs", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).post(PR, "doc", BODY);
			assert.strictEqual(result._tag, "posted");
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([
					comment({id: 7, login: "cansirin", body: `review-doc: PASS @ ${OLD} — merge-ready`}),
				]),
				[`POST ${P}/issues/${PR}/comments`]: "1000",
			}),
		),
	);

	it.effect(
		"a cross-namespace body (review-code on a doc post) → VerdictInputError, no write",
		() =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					(yield* Github).post(PR, "doc", `review-code: PASS @ ${HEAD} — merge-ready`),
				);
				assert.isTrue(error instanceof VerdictInputError);
			}).pipe((effect) =>
				provide(effect, {
					"GET user": "usirin",
					[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([]),
				}),
			),
	);

	// The #2646 emission guard: a polarity-bearing (PASS/FAIL) body with an empty/malformed SHA is
	// the observed unbindable `@-` marker — refused fail-closed at emission, never POSTed, so the
	// read side never has to false-BLOCK it. No POST/PATCH fixture is supplied: a write would 404.
	it.effect("a PASS body with an EMPTY `@ <sha>` → VerdictInputError, no write", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip((yield* Github).post(PR, "doc", "review-doc: PASS @ -"));
			assert.isTrue(error instanceof VerdictInputError);
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([]),
			}),
		),
	);

	it.effect("a FAIL body with a too-short (<7 hex) SHA → VerdictInputError, no write", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip((yield* Github).post(PR, "doc", "review-doc: FAIL @ abc12"));
			assert.isTrue(error instanceof VerdictInputError);
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([]),
			}),
		),
	);

	it.effect("a well-formed `PASS @ <40hex>` body → POSTed (the guard passes it through)", () =>
		Effect.gen(function* () {
			const sha40 = "a".repeat(40);
			const result = yield* (yield* Github).post(PR, "doc", `review-doc: PASS @ ${sha40}`);
			assert.deepStrictEqual(result, {_tag: "posted", commentId: 777});
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([]),
				[`POST ${P}/issues/${PR}/comments`]: "777",
			}),
		),
	);

	it.effect("an advisory (SHA-less, no polarity) body is still POSTed", () =>
		Effect.gen(function* () {
			const result = yield* (yield* Github).post(PR, "doc", "review-doc: advisory — see thread");
			assert.deepStrictEqual(result, {_tag: "posted", commentId: 888});
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${PR}/comments`]: JSON.stringify([]),
				[`POST ${P}/issues/${PR}/comments`]: "888",
			}),
		),
	);
});
