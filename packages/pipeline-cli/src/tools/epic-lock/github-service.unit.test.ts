import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {GhCommandError, Github, GithubLive, type RepoResolutionError} from "./github.ts";

// The live layer resolves its repo lazily (ADR 0062 §1); pin the env override so the
// fixtures keyed on `repos/kamp-us/phoenix/...` match without the ambient `gh repo view`.
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

/**
 * A `ChildProcessSpawner` answering `gh api` from a `${method} ${path}` fixture map
 * (POST/GET/DELETE against the same REST path disambiguate by method). An unmapped
 * key exits 1 (a not-found).
 */
const mockSpawner = (
	responses: Record<string, Response>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const rawPath = args.find((a) => a.startsWith("repos/")) ?? "";
				const path = rawPath.replace(/\?.*$/, "");
				const key = `${methodOf(args)} ${path}`;
				// key on PRESENCE, not truthiness: a DELETE fixture maps to "" (empty stdout),
				// which is falsy — a truthiness check would mis-route it to the not-found branch.
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

const EPIC = 900;
const P = `repos/kamp-us/phoenix`;
const SID_MINE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SID_FORGED = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const claimComment = (over: {
	readonly id: number;
	readonly login: string;
	readonly session: string;
	readonly at?: string;
}) =>
	({
		id: over.id,
		created_at: over.at ?? "2026-07-08T00:00:00Z",
		user: {login: over.login},
		body: `claim: ${over.session} · ${over.at ?? "2026-07-08T00:00:00Z"}`,
	}) as const;

describe("Github.acquire — the two-layer lock over a mock gh spawner", () => {
	it.effect("held label → held-by-other (Rule 0 defer, non-mutating)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const result = yield* github.acquire(EPIC, SID_MINE);
			assert.deepStrictEqual(result, {_tag: "held-by-other"});
		}).pipe((effect) =>
			provide(effect, {[`GET ${P}/issues/${EPIC}`]: JSON.stringify(["status:planning", "p1"])}),
		),
	);

	it.effect(
		"clean win: label posts, claim posts, our claim is the earliest authorized → acquired",
		() =>
			Effect.gen(function* () {
				const github = yield* Github;
				const result = yield* github.acquire(EPIC, SID_MINE);
				assert.deepStrictEqual(result, {_tag: "acquired"});
			}).pipe((effect) =>
				provide(effect, {
					[`GET ${P}/issues/${EPIC}`]: JSON.stringify([]),
					[`POST ${P}/issues/${EPIC}/labels`]: "[]",
					[`POST ${P}/issues/${EPIC}/comments`]: "700",
					[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([
						claimComment({id: 700, login: "usirin", session: SID_MINE}),
					]),
					[`GET ${P}/collaborators/usirin/permission`]: "write",
				}),
			),
	);

	it.effect(
		"422 missing label: the label POST fails → label-missing (fail-closed, non-mutating)",
		() =>
			Effect.gen(function* () {
				const github = yield* Github;
				const result = yield* github.acquire(EPIC, SID_MINE);
				assert.strictEqual(result._tag, "label-missing");
			}).pipe((effect) =>
				provide(effect, {
					[`GET ${P}/issues/${EPIC}`]: JSON.stringify([]),
					[`POST ${P}/issues/${EPIC}/labels`]: {
						stdout: "",
						exitCode: 1,
						stderr: "HTTP 422: Label does not exist",
					},
				}),
			),
	);

	it.effect("lost co-acquire: an earlier authorized claim from another session → lost", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const result = yield* github.acquire(EPIC, SID_MINE);
			assert.deepStrictEqual(result, {_tag: "lost", winner: SID_OTHER});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${EPIC}`]: JSON.stringify([]),
				[`POST ${P}/issues/${EPIC}/labels`]: "[]",
				[`POST ${P}/issues/${EPIC}/comments`]: "800",
				[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([
					claimComment({id: 500, login: "usirin", session: SID_OTHER, at: "2026-07-08T00:00:01Z"}),
					claimComment({id: 800, login: "usirin", session: SID_MINE, at: "2026-07-08T00:00:02Z"}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
				// the lost path retracts our own claim comment (ignored on failure)
				[`DELETE ${P}/issues/comments/800`]: "",
			}),
		),
	);

	it.effect("a forged claim from a non-collaborator is ignored → our authorized claim wins", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const result = yield* github.acquire(EPIC, SID_MINE);
			assert.deepStrictEqual(result, {_tag: "acquired"});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${EPIC}`]: JSON.stringify([]),
				[`POST ${P}/issues/${EPIC}/labels`]: "[]",
				[`POST ${P}/issues/${EPIC}/comments`]: "900",
				[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([
					// earliest, but forged (non-collaborator) — must be dropped
					claimComment({
						id: 10,
						login: "attacker",
						session: SID_FORGED,
						at: "2026-07-08T00:00:00Z",
					}),
					claimComment({id: 900, login: "usirin", session: SID_MINE, at: "2026-07-08T00:00:05Z"}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
				[`GET ${P}/collaborators/attacker/permission`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Not Found",
				},
			}),
		),
	);
});

describe("Github.release — retract our claim + drop the label", () => {
	it.effect("retracts our claim comment and removes the label → released", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const result = yield* github.release(EPIC, SID_MINE);
			assert.deepStrictEqual(result, {_tag: "released", retracted: 1, labelRemoved: true});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([
					claimComment({id: 55, login: "usirin", session: SID_MINE}),
					claimComment({id: 66, login: "usirin", session: SID_OTHER}),
				]),
				[`DELETE ${P}/issues/comments/55`]: "",
				[`DELETE ${P}/issues/${EPIC}/labels/status:planning`]: "",
			}),
		),
	);

	it.effect("label DELETE 404 is benign → released with labelRemoved=false", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const result = yield* github.release(EPIC, SID_MINE);
			assert.deepStrictEqual(result, {_tag: "released", retracted: 0, labelRemoved: false});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([]),
				[`DELETE ${P}/issues/${EPIC}/labels/status:planning`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Label does not exist",
				},
			}),
		),
	);

	it.effect("a non-404 label DELETE failure is LOUD (propagates GhCommandError)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const error = yield* Effect.flip(github.release(EPIC, SID_MINE));
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${EPIC}/comments`]: JSON.stringify([]),
				[`DELETE ${P}/issues/${EPIC}/labels/status:planning`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 500: server error",
				},
			}),
		),
	);
});
