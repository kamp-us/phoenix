import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Github, GithubLive, type RepoResolutionError} from "./github.ts";

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
 * A `ChildProcessSpawner` answering `gh api` from a `${method} ${path}` fixture map.
 * An unmapped key exits 1 (a not-found) — which is how a non-collaborator's
 * `collaborators/<login>/permission` 404 is modelled.
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

const ISSUE = 3687;
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

describe("Github.isMine — the issue-scoped default-deny resolver over a mock gh spawner", () => {
	it.effect("earliest authorized claim is ours → mine", () =>
		Effect.gen(function* () {
			const verdict = yield* (yield* Github).isMine(ISSUE, SID_MINE);
			assert.strictEqual(verdict.mine, true);
			assert.strictEqual(verdict.reason, "won");
			assert.strictEqual(verdict.winner?.session, SID_MINE);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${ISSUE}/comments`]: JSON.stringify([
					claimComment({id: 700, login: "usirin", session: SID_MINE}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect("a foreign earlier authorized claim owns the issue → not-mine (lost)", () =>
		Effect.gen(function* () {
			const verdict = yield* (yield* Github).isMine(ISSUE, SID_MINE);
			assert.strictEqual(verdict.mine, false);
			assert.strictEqual(verdict.reason, "lost");
			assert.strictEqual(verdict.winner?.session, SID_OTHER);
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${ISSUE}/comments`]: JSON.stringify([
					claimComment({id: 500, login: "usirin", session: SID_OTHER, at: "2026-07-08T00:00:01Z"}),
					claimComment({id: 800, login: "usirin", session: SID_MINE, at: "2026-07-08T00:00:02Z"}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect(
		"FAIL-SAFE: only a forged non-collaborator claim exists → not-mine (default-deny, no-winner)",
		() =>
			Effect.gen(function* () {
				const verdict = yield* (yield* Github).isMine(ISSUE, SID_MINE);
				assert.strictEqual(verdict.mine, false);
				assert.strictEqual(verdict.reason, "no-winner");
			}).pipe((effect) =>
				provide(effect, {
					[`GET ${P}/issues/${ISSUE}/comments`]: JSON.stringify([
						claimComment({id: 10, login: "attacker", session: SID_FORGED}),
					]),
					// a non-collaborator's permission probe 404s → dropped from the authorized set
					[`GET ${P}/collaborators/attacker/permission`]: {
						stdout: "",
						exitCode: 1,
						stderr: "HTTP 404: Not Found",
					},
				}),
			),
	);

	it.effect("FAIL-SAFE: an unclaimed issue (no claim comments) → not-mine (default-deny)", () =>
		Effect.gen(function* () {
			const verdict = yield* (yield* Github).isMine(ISSUE, SID_MINE);
			assert.strictEqual(verdict.mine, false);
			assert.strictEqual(verdict.reason, "no-winner");
		}).pipe((effect) =>
			provide(effect, {[`GET ${P}/issues/${ISSUE}/comments`]: JSON.stringify([])}),
		),
	);

	it.effect("FAIL-SAFE: a null session id → not-mine (default-deny, no-session)", () =>
		Effect.gen(function* () {
			const verdict = yield* (yield* Github).isMine(ISSUE, null);
			assert.strictEqual(verdict.mine, false);
			assert.strictEqual(verdict.reason, "no-session");
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${ISSUE}/comments`]: JSON.stringify([
					claimComment({id: 700, login: "usirin", session: SID_MINE}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);
});
