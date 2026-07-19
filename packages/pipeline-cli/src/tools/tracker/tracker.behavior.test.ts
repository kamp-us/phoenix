import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {
	GhCommandError,
	GithubTrackerLive,
	type RepoResolutionError,
	Tracker,
	TrackerInputError,
	TrackerNotImplementedError,
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
 * (POST/GET/DELETE against the same REST path disambiguate by method). An unmapped key
 * exits 1 (a not-found), the same shared shape the `epic-lock` github-service tests use.
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
				// route on the REST path when present, else on the `gh <sub> <verb>` shape (e.g. `api user`)
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
	effect: Effect.Effect<A, E, Tracker>,
	responses: Record<string, Response>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubTrackerLive.pipe(Layer.provide(mockSpawner(responses)))));

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
				[`POST ${L}`]: JSON.stringify([{name: "type:feature"}, {name: "p2"}]),
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: "",
				// read-back reflects the post-transition state: the queue label is gone.
				[`GET ${L}`]: JSON.stringify([
					{name: "type:feature"},
					{name: "p2"},
					{name: "status:triaged"},
				]),
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
				[`POST ${L}`]: JSON.stringify([{name: "type:bug"}]),
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: "",
				[`GET ${L}`]: JSON.stringify([
					{name: "type:bug"},
					{name: "p1"},
					{name: "status:needs-info"},
				]),
			}),
		),
	);

	it.effect("the queue label already absent (404 on remove) → still triaged (idempotent)", () =>
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
				[`POST ${L}`]: JSON.stringify([{name: "type:chore"}]),
				// a pre-bootstrap issue never carried the queue label → the remove 404s, tolerated.
				[`DELETE ${P}/issues/${TARGET}/labels/status:needs-triage`]: {
					stdout: "",
					exitCode: 1,
					stderr: "HTTP 404: Label does not exist",
				},
				[`GET ${L}`]: JSON.stringify([
					{name: "type:chore"},
					{name: "p2"},
					{name: "status:triaged"},
				]),
			}),
		),
	);

	it.effect("a non-zero gh add-labels exit → GhCommandError in the E channel", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(
				tracker.applyTriage(TARGET, {type: "feature", priority: "p2"}),
			);
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) =>
			// no POST fixture → the add-labels call exits 1 → GhCommandError, never a throw.
			provide(effect, {}),
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

describe("Tracker — the declared-but-not-yet-built verbs fail closed", () => {
	it.effect("graduate → TrackerNotImplementedError", () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const error = yield* Effect.flip(tracker.graduate(TARGET, {stage: "triaged"}));
			assert.isTrue(error instanceof TrackerNotImplementedError);
			assert.strictEqual(error.verb, "graduate");
		}).pipe((effect) => provide(effect, {})),
	);
});
