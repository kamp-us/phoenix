import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {parseClaimPresence} from "../epic-lock/claim-presence.ts";
import {CLAIM_RE} from "../epic-lock/claim-resolution.ts";
import {
	GhCommandError,
	GithubTrackerLive,
	type RepoResolutionError,
	Tracker,
	TrackerInputError,
	TrackerVerifyError,
} from "./tracker.ts";

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
// An array fixture answers successive calls on the same key, the last entry repeating — the only
// way to express a read-modify-read verb (`applyTriage` reads labels before and after its writes).
type Response = string | Canned | ReadonlyArray<string | Canned>;

const enc = new TextEncoder();
const normalize = (response: string | Canned): Canned =>
	typeof response === "string" ? {stdout: response} : response;

const methodOf = (args: ReadonlyArray<string>): string => {
	const i = args.indexOf("-X");
	return i >= 0 ? (args[i + 1] ?? "GET") : "GET";
};

/**
 * A `ChildProcessSpawner` answering `gh api` from a `${method} ${path}` fixture map
 * (POST/GET/DELETE against the same REST path disambiguate by method). An unmapped key
 * exits 1 (a not-found), the same shared shape the `epic-lock` github-service tests use.
 */
const mockSpawner = (
	responses: Record<string, Response>,
	calls?: Array<string>,
	// Every `-f body=…` the verb sent, in order — what proves WHAT a writer posted, not just that
	// it posted (the #3987 regression: an unstamped claim marker is indistinguishable by key alone).
	bodies?: Array<string>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
	const seen = new Map<string, number>();
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				// route on the REST path when present, else on the `gh <sub> <verb>` shape (e.g. `api user`)
				const rawPath =
					args.find((a) => a.startsWith("repos/")) ??
					(args[0] === "api" ? (args[1] ?? "") : args.slice(0, 2).join(" "));
				const path = rawPath.replace(/\?.*$/, "");
				const key = `${methodOf(args)} ${path}`;
				calls?.push(key);
				for (const arg of args) {
					if (arg.startsWith("body=")) bodies?.push(arg.slice("body=".length));
				}
				const nth = seen.get(key) ?? 0;
				seen.set(key, nth + 1);
				const fixture = responses[key];
				const canned =
					fixture === undefined
						? {stdout: "", exitCode: 1, stderr: `not found: ${key}`}
						: normalize(
								Array.isArray(fixture)
									? (fixture[Math.min(nth, fixture.length - 1)] ?? "")
									: (fixture as string | Canned),
							);
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
};

const provide = <A, E>(
	effect: Effect.Effect<A, E, Tracker>,
	responses: Record<string, Response>,
	calls?: Array<string>,
	bodies?: Array<string>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(
		Effect.provide(GithubTrackerLive.pipe(Layer.provide(mockSpawner(responses, calls, bodies)))),
	);

const TARGET = 900;
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

describe("Tracker.claim — the ADR-0115 claim over a mock gh spawner", () => {
	it.effect("no prior claim: we POST and our authorized claim is earliest → claimed", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.claim(TARGET, {session: SID_MINE});
			assert.deepStrictEqual(result, {_tag: "claimed", session: SID_MINE});
		}).pipe((effect) =>
			provide(effect, {
				// pre-check GET (empty), POST claim, checkpoint GET (our claim now present)
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					claimComment({id: 700, login: "usirin", session: SID_MINE}),
				]),
				[`POST ${P}/issues/${TARGET}/comments`]: "700",
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect(
		"a pre-existing owner from another session → held-by-other (Rule 0, non-mutating)",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				const result = yield* tracker.claim(TARGET, {session: SID_MINE});
				assert.deepStrictEqual(result, {
					_tag: "held-by-other",
					owner: {session: SID_OTHER, claimedAt: "2026-07-08T00:00:00Z"},
				});
			}).pipe((effect) =>
				provide(effect, {
					[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
						claimComment({id: 500, login: "usirin", session: SID_OTHER}),
					]),
					[`GET ${P}/collaborators/usirin/permission`]: "write",
				}),
			),
	);

	it.effect("we already own it → claimed idempotently, no double-post", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.claim(TARGET, {session: SID_MINE});
			assert.deepStrictEqual(result, {_tag: "claimed", session: SID_MINE});
		}).pipe((effect) =>
			provide(effect, {
				// no POST fixture: an idempotent claim must NOT post a second comment
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					claimComment({id: 400, login: "usirin", session: SID_MINE}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect("lost co-race: an earlier authorized claim wins the checkpoint → lost + retract", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.claim(TARGET, {session: SID_MINE});
			assert.deepStrictEqual(result, {
				_tag: "lost",
				owner: {session: SID_OTHER, claimedAt: "2026-07-08T00:00:01Z"},
			});
		}).pipe((effect) => {
			let getCount = 0;
			// pre-check sees no claim (we proceed to POST); the checkpoint GET then reveals an
			// earlier authorized claim landed concurrently, so we lose and retract our own.
			return effect.pipe(
				Effect.provide(
					GithubTrackerLive.pipe(
						Layer.provide(
							Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
								ChildProcessSpawner.make(
									Effect.fnUntraced(function* (command) {
										let cmd = command;
										while (cmd._tag === "PipedCommand") cmd = cmd.left;
										const args = cmd._tag === "StandardCommand" ? cmd.args : [];
										const rawPath = args.find((a) => a.startsWith("repos/")) ?? "";
										const path = rawPath.replace(/\?.*$/, "");
										const method = methodOf(args);
										let stdout = "";
										let exitCode = 0;
										if (method === "GET" && path === `${P}/issues/${TARGET}/comments`) {
											getCount += 1;
											stdout =
												getCount === 1
													? JSON.stringify([])
													: JSON.stringify([
															claimComment({
																id: 500,
																login: "usirin",
																session: SID_OTHER,
																at: "2026-07-08T00:00:01Z",
															}),
															claimComment({
																id: 800,
																login: "usirin",
																session: SID_MINE,
																at: "2026-07-08T00:00:02Z",
															}),
														]);
										} else if (method === "POST" && path === `${P}/issues/${TARGET}/comments`) {
											stdout = "800";
										} else if (path === `${P}/collaborators/usirin/permission`) {
											stdout = "write";
										} else if (method === "DELETE" && path === `${P}/issues/comments/800`) {
											stdout = "";
										} else {
											exitCode = 1;
										}
										return ChildProcessSpawner.makeHandle({
											pid: ChildProcessSpawner.ProcessId(1),
											stdin: Sink.drain,
											stdout: Stream.fromIterable([enc.encode(stdout)]),
											stderr: Stream.fromIterable([enc.encode("")]),
											all: Stream.fromIterable([enc.encode(stdout)]),
											exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
											isRunning: Effect.succeed(false),
											kill: () => Effect.void,
											getInputFd: () => Sink.drain,
											getOutputFd: () => Stream.empty,
											unref: Effect.succeed(Effect.void),
										});
									}),
								),
							),
						),
					),
				),
			);
		}),
	);

	it.effect("a forged claim from a non-collaborator is ignored → our authorized claim wins", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.claim(TARGET, {session: SID_MINE});
			assert.deepStrictEqual(result, {_tag: "claimed", session: SID_MINE});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					// earliest, but forged (non-collaborator) — must be dropped before the tiebreak
					claimComment({id: 10, login: "attacker", session: SID_FORGED}),
					claimComment({
						id: 900,
						login: "usirin",
						session: SID_MINE,
						at: "2026-07-08T00:00:05Z",
					}),
				]),
				[`POST ${P}/issues/${TARGET}/comments`]: "900",
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

// #3987: the claim WRITE is what makes liveness evaluable later. Assert the posted BODY, not just
// that a POST happened — an unstamped marker is a well-formed claim that no reader can ever probe.
describe("Tracker.claim — the posted marker carries the presence stamp (#3987)", () => {
	// pre-check GET sees no claim (so we actually POST), then the checkpoint GET sees ours land.
	const cleanWin: Record<string, Response> = {
		[`GET ${P}/issues/${TARGET}/comments`]: [
			JSON.stringify([]),
			JSON.stringify([claimComment({id: 700, login: "usirin", session: SID_MINE})]),
		],
		[`POST ${P}/issues/${TARGET}/comments`]: "700",
		[`GET ${P}/collaborators/usirin/permission`]: "write",
	};

	it.effect("stamps the injected session presence onto the marker it posts", () =>
		Effect.gen(function* () {
			const bodies: string[] = [];
			yield* Effect.provide(
				Effect.flatMap(Tracker, (tracker) =>
					tracker.claim(TARGET, {session: SID_MINE, presence: {host: "box-1", pid: 4242}}),
				),
				GithubTrackerLive.pipe(Layer.provide(mockSpawner(cleanWin, undefined, bodies))),
			);
			const posted = bodies.at(0) ?? "";
			assert.match(posted, CLAIM_RE, "the posted body must be a canonical claim marker");
			assert.deepStrictEqual(parseClaimPresence(posted), {host: "box-1", pid: 4242});
		}),
	);

	it.effect(
		"an unresolvable session presence posts a legacy unstamped marker (no wrong stamp)",
		() =>
			Effect.gen(function* () {
				const bodies: string[] = [];
				yield* Effect.provide(
					Effect.flatMap(Tracker, (tracker) =>
						tracker.claim(TARGET, {session: SID_MINE, presence: null}),
					),
					GithubTrackerLive.pipe(Layer.provide(mockSpawner(cleanWin, undefined, bodies))),
				);
				const posted = bodies.at(0) ?? "";
				assert.match(posted, CLAIM_RE);
				assert.strictEqual(parseClaimPresence(posted), null);
			}),
	);
});

describe("Tracker.readBack — resolve the current owner", () => {
	it.effect("an authorized claim present → owned", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.readBack(TARGET);
			assert.deepStrictEqual(result, {
				_tag: "owned",
				owner: {session: SID_MINE, claimedAt: "2026-07-08T00:00:00Z"},
			});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					claimComment({id: 700, login: "usirin", session: SID_MINE}),
				]),
				[`GET ${P}/collaborators/usirin/permission`]: "write",
			}),
		),
	);

	it.effect("no claim comments → unclaimed", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.readBack(TARGET);
			assert.deepStrictEqual(result, {_tag: "unclaimed"});
		}).pipe((effect) =>
			provide(effect, {[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([])}),
		),
	);

	it.effect("only a forged (non-collaborator) claim → unclaimed (fail-closed)", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.readBack(TARGET);
			assert.deepStrictEqual(result, {_tag: "unclaimed"});
		}).pipe((effect) =>
			provide(effect, {
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					claimComment({id: 10, login: "attacker", session: SID_FORGED}),
				]),
				[`GET ${P}/collaborators/attacker/permission`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Not Found",
				},
			}),
		),
	);
});

describe("Tracker.applyTriage — the label-transition envelope over a mock gh spawner", () => {
	const L = `${P}/issues/${TARGET}/labels`;

	const labelSet = (...names: ReadonlyArray<string>) =>
		JSON.stringify(names.map((name) => ({name})));

	it.effect("adds type/priority/status, removes needs-triage, reads back → triaged", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.applyTriage(TARGET, {type: "feature", priority: "p2"});
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "feature",
				priority: "p2",
				status: "triaged",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${L}`]: labelSet("type:feature", "p2"),
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: "",
				// pre-read: still queued; read-back reflects the post-transition state.
				[`GET ${L}`]: [
					labelSet("status:needs-triage"),
					labelSet("type:feature", "p2", "status:triaged"),
				],
			}),
		),
	);

	it.effect("honors an explicit --status stage and reports the stage that landed", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.applyTriage(TARGET, {
				type: "bug",
				priority: "p1",
				status: "needs-info",
			});
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "bug",
				priority: "p1",
				status: "needs-info",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${L}`]: labelSet("type:bug"),
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: "",
				[`GET ${L}`]: [
					labelSet("status:needs-triage"),
					labelSet("type:bug", "p1", "status:needs-info"),
				],
			}),
		),
	);

	it.effect("the queue label already absent → no remove is attempted (idempotent)", () =>
		Effect.gen(function* () {
			const calls: Array<string> = [];
			const result = yield* Effect.gen(function* () {
				return yield* (yield* Tracker).applyTriage(TARGET, {type: "chore", priority: "p2"});
			}).pipe((effect) =>
				provide(
					effect,
					{
						[`POST ${L}`]: labelSet("type:chore"),
						// a pre-bootstrap issue never carried the queue label; nothing is superseded.
						[`GET ${L}`]: labelSet("type:chore", "p2", "status:triaged"),
					},
					calls,
				),
			);
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "chore",
				priority: "p2",
				status: "triaged",
			});
			// no DELETE fixture exists — an attempted removal would have exited 1 and failed the verb.
			assert.deepStrictEqual(
				calls.filter((call) => call.startsWith("DELETE")),
				[],
			);
		}),
	);

	it.effect("a concurrent removal (404 on remove) is tolerated → still triaged", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.applyTriage(TARGET, {type: "chore", priority: "p2"});
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "chore",
				priority: "p2",
				status: "triaged",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${L}`]: labelSet("type:chore"),
				// the queue label vanished between the pre-read and the remove → 404, tolerated.
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Label does not exist",
				},
				[`GET ${L}`]: [
					labelSet("status:needs-triage"),
					labelSet("type:chore", "p2", "status:triaged"),
				],
			}),
		),
	);

	// The #3771 defect: re-prioritizing an already-triaged issue was ADDITIVE, so the old `p2`
	// survived alongside the new `p1` and the queue's pick order went ambiguous. Same for a re-type.
	it.effect("re-triage of an already-triaged issue removes the superseded type AND priority", () =>
		Effect.gen(function* () {
			const calls: Array<string> = [];
			const result = yield* Effect.gen(function* () {
				return yield* (yield* Tracker).applyTriage(TARGET, {type: "decision", priority: "p1"});
			}).pipe((effect) =>
				provide(
					effect,
					{
						[`POST ${L}`]: labelSet("type:decision", "p1"),
						[`DELETE ${P}/issues/${TARGET}/labels/type:bug`]: "",
						[`DELETE ${P}/issues/${TARGET}/labels/p2`]: "",
						[`GET ${L}`]: [
							// already triaged: type:bug / p2 / status:triaged, plus an unrelated label.
							labelSet("type:bug", "status:triaged", "p2", "epic"),
							labelSet("type:decision", "status:triaged", "p1", "epic"),
						],
					},
					calls,
				),
			);
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "decision",
				priority: "p1",
				status: "triaged",
			});
			// exactly the two superseded facet members are removed — `status:triaged` is already
			// the desired member, and `epic` is outside the contract, so neither is touched.
			assert.deepStrictEqual(calls.filter((call) => call.startsWith("DELETE")).sort(), [
				`DELETE ${P}/issues/${TARGET}/labels/p2`,
				`DELETE ${P}/issues/${TARGET}/labels/type:bug`,
			]);
		}),
	);

	// The status facet owns the pickability spine, not the whole `status:` namespace: an issue
	// dark-shipped behind a flag carries `status:awaiting-release` alongside `status:triaged`, and
	// that marker IS the human release queue's membership. A re-prioritize that removed it would
	// silently orphan the pending flag flip.
	it.effect("a re-prioritize retains an orthogonal `status:awaiting-release`", () =>
		Effect.gen(function* () {
			const calls: Array<string> = [];
			const result = yield* Effect.gen(function* () {
				return yield* (yield* Tracker).applyTriage(TARGET, {type: "bug", priority: "p1"});
			}).pipe((effect) =>
				provide(
					effect,
					{
						[`POST ${L}`]: labelSet("type:bug", "p1"),
						[`DELETE ${P}/issues/${TARGET}/labels/p2`]: "",
						[`GET ${L}`]: [
							labelSet("type:bug", "status:triaged", "p2", "status:awaiting-release"),
							labelSet("type:bug", "status:triaged", "p1", "status:awaiting-release"),
						],
					},
					calls,
				),
			);
			assert.deepStrictEqual(result, {
				_tag: "triaged",
				type: "bug",
				priority: "p1",
				status: "triaged",
			});
			// only the superseded priority is removed — the release-queue marker survives.
			assert.deepStrictEqual(
				calls.filter((call) => call.startsWith("DELETE")),
				[`DELETE ${P}/issues/${TARGET}/labels/p2`],
			);
		}),
	);

	it.effect("a non-zero gh label exit → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(
				tracker.applyTriage(TARGET, {type: "feature", priority: "p2"}),
			);
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) =>
			// no fixtures → the label read exits 1 → GhCommandError, never a throw. Only the
			// per-label REMOVE is 404-tolerant; a failed read or add still fails the verb.
			provide(effect, {}),
		),
	);

	it.effect("a non-zero exit on the ADD → GhCommandError (only the remove is tolerant)", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(
				tracker.applyTriage(TARGET, {type: "feature", priority: "p2"}),
			);
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) =>
			// the pre-read succeeds, so the add is what fails: no `POST` fixture → exit 1.
			provide(effect, {[`GET ${L}`]: labelSet("status:needs-triage")}),
		),
	);
});

describe("Tracker.postVerdict — the ADR-0058 verdict/comment-post + read-back envelope", () => {
	// A full 40-hex head SHA — the ONLY shape the tightened emission guard (#2683) accepts on a
	// POSTed marker, so the composed `review-<gate>: PASS @ <sha>` first line is bindable.
	const HEAD40 = `${"a1b2c3d4e5f6".repeat(3)}a1b2`; // 12*3 + 4 = 40 hex
	const PROSE = "all acceptance criteria met — merge-ready.";
	const LANDED_PASS = `review-code: PASS @ ${HEAD40}\n\n${PROSE}`;

	const verdictComment = (over: {
		readonly id: number;
		readonly login: string;
		readonly body: string;
	}) =>
		({
			id: over.id,
			created_at: "2026-07-11T00:00:00Z",
			user: {login: over.login},
			body: over.body,
		}) as const;

	it.effect(
		"no prior own marker → POST a fresh verdict, self-verify the landed body → posted",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				const result = yield* tracker.postVerdict(TARGET, {
					gate: "code",
					passed: true,
					headRef: HEAD40,
					body: PROSE,
				});
				assert.deepStrictEqual(result, {
					_tag: "posted",
					gate: "code",
					passed: true,
					headRef: HEAD40,
				});
			}).pipe((effect) =>
				provide(effect, {
					"GET user": "usirin",
					[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([]),
					[`POST ${P}/issues/${TARGET}/comments`]: "999",
					// the #3019 read-back: postVerdict re-fetches the landed comment and re-runs emissionDefect
					[`GET ${P}/issues/comments/999`]: LANDED_PASS,
				}),
			),
	);

	it.effect("our own prior marker in the namespace → PATCH it (upsert, not append) → patched", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.postVerdict(TARGET, {
				gate: "code",
				passed: true,
				headRef: HEAD40,
				body: PROSE,
			});
			assert.deepStrictEqual(result, {
				_tag: "patched",
				gate: "code",
				passed: true,
				headRef: HEAD40,
			});
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				// our own prior review-code marker exists → the upsert PATCHes it, never a second POST
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([
					verdictComment({id: 42, login: "usirin", body: `review-code: FAIL @ ${HEAD40}\n\nstale`}),
				]),
				[`PATCH ${P}/issues/comments/42`]: "42",
				[`GET ${P}/issues/comments/42`]: LANDED_PASS,
			}),
		),
	);

	it.effect("an unknown gate → TrackerInputError before any write", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(
				tracker.postVerdict(TARGET, {gate: "bogus", passed: true, headRef: HEAD40, body: PROSE}),
			);
			assert.isTrue(error instanceof TrackerInputError);
		}).pipe((effect) => provide(effect, {})),
	);

	it.effect("a non-40-hex head → emission defect → TrackerInputError, no write", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			// no POST/PATCH fixture: the emission guard must refuse before any write reaches GitHub
			const error = yield* Effect.flip(
				tracker.postVerdict(TARGET, {gate: "code", passed: false, headRef: "abc123", body: PROSE}),
			);
			assert.isTrue(error instanceof TrackerInputError);
		}).pipe((effect) => provide(effect, {"GET user": "usirin"})),
	);

	it.effect("the landed body fails self-verify → TrackerVerifyError (never a false success)", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(
				tracker.postVerdict(TARGET, {gate: "code", passed: true, headRef: HEAD40, body: PROSE}),
			);
			assert.isTrue(error instanceof TrackerVerifyError);
		}).pipe((effect) =>
			provide(effect, {
				"GET user": "usirin",
				[`GET ${P}/issues/${TARGET}/comments`]: JSON.stringify([]),
				[`POST ${P}/issues/${TARGET}/comments`]: "999",
				// the landed body is not a clean in-namespace marker — the folded-in read-back rejects it
				[`GET ${P}/issues/comments/999`]: "oops — a hand-edited body with no marker",
			}),
		),
	);

	it.effect("a non-zero gh exit on whoami → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			// no `GET user` fixture → whoami exits 1 → GhCommandError, never a throw or a silent post
			const error = yield* Effect.flip(
				tracker.postVerdict(TARGET, {gate: "code", passed: true, headRef: HEAD40, body: PROSE}),
			);
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) => provide(effect, {})),
	);
});

describe("Tracker.createIssue — the intake-create envelope over a mock gh spawner", () => {
	it.effect("files a needs-triage issue by default → created with its ref + url", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.createIssue({
				title: "a new finding",
				body: "## Summary\n…",
			});
			assert.deepStrictEqual(result, {
				_tag: "created",
				target: 4242,
				url: "https://github.com/kamp-us/phoenix/issues/4242",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${P}/issues`]: JSON.stringify({
					number: 4242,
					html_url: "https://github.com/kamp-us/phoenix/issues/4242",
				}),
			}),
		),
	);

	it.effect("honors an explicit --stage lifecycle stage", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.createIssue({
				title: "a planned child",
				body: "…",
				stage: "planned",
			});
			assert.deepStrictEqual(result, {
				_tag: "created",
				target: 77,
				url: "https://github.com/kamp-us/phoenix/issues/77",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${P}/issues`]: JSON.stringify({
					number: 77,
					html_url: "https://github.com/kamp-us/phoenix/issues/77",
				}),
			}),
		),
	);

	it.effect("a non-zero gh create exit → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(tracker.createIssue({title: "t", body: "b"}));
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) =>
			// no POST fixture → the create call exits 1 → GhCommandError, never a throw.
			provide(effect, {}),
		),
	);
});

describe("Tracker.createComment — add a note over a mock gh spawner", () => {
	it.effect("posts a note to the entity → commented with its ref", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.createComment(TARGET, {body: "a handoff note"});
			assert.deepStrictEqual(result, {_tag: "commented", ref: 5150});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${P}/issues/${TARGET}/comments`]: JSON.stringify({id: 5150}),
			}),
		),
	);

	it.effect("a non-zero gh comment exit → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(tracker.createComment(TARGET, {body: "b"}));
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) => provide(effect, {})),
	);
});

describe("Tracker.graduate — the map/investigation graduation-close envelope", () => {
	it.effect(
		"posts the source → artifact provenance record, closes as completed, reads back → graduated",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				const result = yield* tracker.graduate(TARGET, {
					artifact: "epic #4242 (planned by plan-epic)",
					note: "its diagnosis is carried forward by the epic.",
				});
				assert.deepStrictEqual(result, {
					_tag: "graduated",
					source: TARGET,
					artifact: "epic #4242 (planned by plan-epic)",
					state: "closed",
				});
			}).pipe((effect) =>
				provide(effect, {
					[`POST ${P}/issues/${TARGET}/comments`]: JSON.stringify({id: 6060}),
					[`PATCH ${P}/issues/${TARGET}`]: JSON.stringify({
						state: "closed",
						state_reason: "completed",
					}),
				}),
			),
	);

	it.effect("composes `Graduated into <artifact>` with no note when none is given", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const result = yield* tracker.graduate(TARGET, {artifact: "#1, #2 → triage; ADR 0176"});
			assert.deepStrictEqual(result, {
				_tag: "graduated",
				source: TARGET,
				artifact: "#1, #2 → triage; ADR 0176",
				state: "closed",
			});
		}).pipe((effect) =>
			provide(effect, {
				[`POST ${P}/issues/${TARGET}/comments`]: JSON.stringify({id: 6061}),
				[`PATCH ${P}/issues/${TARGET}`]: JSON.stringify({
					state: "closed",
					state_reason: "completed",
				}),
			}),
		),
	);

	it.effect(
		"the close read-back is not `closed` → TrackerVerifyError (never a false graduation)",
		() =>
			Effect.gen(function* () {
				const tracker = yield* Tracker;
				const error = yield* Effect.flip(tracker.graduate(TARGET, {artifact: "epic #99"}));
				assert.isTrue(error instanceof TrackerVerifyError);
			}).pipe((effect) =>
				provide(effect, {
					[`POST ${P}/issues/${TARGET}/comments`]: JSON.stringify({id: 6062}),
					// the PATCH came back still open — the folded-in read-back rejects the graduation
					[`PATCH ${P}/issues/${TARGET}`]: JSON.stringify({state: "open", state_reason: null}),
				}),
			),
	);

	it.effect("a non-zero gh exit on the provenance comment → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			// no POST fixture → the comment call exits 1 → GhCommandError before any close, never a throw
			const error = yield* Effect.flip(tracker.graduate(TARGET, {artifact: "epic #99"}));
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) => provide(effect, {})),
	);
});
