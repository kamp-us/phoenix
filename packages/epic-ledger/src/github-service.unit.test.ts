import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {GhCommandError, GhParseError, Github, GithubLive} from "./github.ts";
import {validateLedger} from "./validate.ts";

/** A canned `gh` response keyed by the URL path the args address. */
interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

/** A response is either the raw stdout JSON string, or a full `Canned`. */
type Response = string | Canned;

const enc = new TextEncoder();

const normalize = (response: Response): Canned =>
	typeof response === "string" ? {stdout: response} : response;

/**
 * A `ChildProcessSpawner` that answers `gh api <path>` from a fixture map. The
 * args are flattened to the addressed REST path so a test states only the
 * responses, not the spawn mechanics. An unmapped path exits 1 (a not-found).
 */
const mockSpawner = (
	responses: Record<string, Response>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const rawPath =
					cmd._tag === "StandardCommand"
						? (cmd.args.find((a) => a.startsWith("repos/")) ?? "")
						: "";
				const path = rawPath.replace(/\?.*$/, "");
				const found = responses[path];
				const canned = found
					? normalize(found)
					: {stdout: "", exitCode: 1, stderr: `not found: ${path}`};
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
): Effect.Effect<A, E> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses)))));

const issue = (number: number, body: string, labels: string[]) =>
	JSON.stringify({
		number,
		title: `#${number}`,
		labels: labels.map((name) => ({name})),
		body,
	});

const EPIC_BODY = [
	"### User stories",
	"1. As a planner, I want X.",
	"2. As an agent, I want Y.",
	"",
	"## Dependencies",
	"- #101",
	"- #102",
].join("\n");

describe("Github.epicLedger — over a mock gh spawner", () => {
	it.effect("assembles a clean, story-covered EpicLedger consumable by validateLedger", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const ledger = yield* github.epicLedger(159);
			assert.strictEqual(ledger.epic.number, 159);
			assert.deepStrictEqual(ledger.epic.stories, [1, 2]);
			assert.strictEqual(ledger.children.length, 2);
			assert.deepStrictEqual(ledger.children[0]?.stories, [1]);
			assert.deepStrictEqual(ledger.children[1]?.stories, [2]);
			assert.deepStrictEqual(validateLedger(ledger), []);
		}).pipe((effect) =>
			provide(effect, {
				"repos/kamp-us/phoenix/issues/159": issue(159, EPIC_BODY, [
					"type:epic",
					"p1",
					"status:triaged",
				]),
				"repos/kamp-us/phoenix/issues/159/sub_issues": JSON.stringify([
					{number: 101},
					{number: 102},
				]),
				"repos/kamp-us/phoenix/issues/101": issue(
					101,
					"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
					["type:feature", "p1", "status:triaged"],
				),
				"repos/kamp-us/phoenix/issues/102": issue(
					102,
					"**Stories:** 2\n### Acceptance criteria\n- [ ] ac",
					["type:feature", "p1", "status:triaged"],
				),
			}),
		),
	);

	it.effect("surfaces a non-zero `gh` exit as a typed GhCommandError (not a throw)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const error = yield* Effect.flip(github.epicLedger(404));
			assert.isTrue(error instanceof GhCommandError);
			if (error instanceof GhCommandError) assert.strictEqual(error.exitCode, 1);
		}).pipe((effect) => provide(effect, {})),
	);

	it.effect("surfaces malformed gh JSON as a typed GhParseError (not a throw)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const error = yield* Effect.flip(github.epicLedger(159));
			assert.isTrue(error instanceof GhParseError);
		}).pipe((effect) =>
			provide(effect, {
				"repos/kamp-us/phoenix/issues/159": "not json {{{",
			}),
		),
	);
});

const XREF_BODY = [
	"### User stories",
	"1. As a planner, I want X.",
	"",
	"## Dependencies",
	"### Phase 1",
	"- #101 — a",
	"- #102 — b (requires: #101, #108)",
].join("\n");

const xrefResponses = (epicNumber: number): Record<string, Response> => ({
	[`repos/kamp-us/phoenix/issues/${epicNumber}`]: issue(epicNumber, XREF_BODY, [
		"type:epic",
		"p1",
		"status:triaged",
	]),
	[`repos/kamp-us/phoenix/issues/${epicNumber}/sub_issues`]: JSON.stringify([
		{number: 101},
		{number: 102},
	]),
	"repos/kamp-us/phoenix/issues/101": issue(
		101,
		"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
		["type:feature", "p1", "status:triaged"],
	),
	"repos/kamp-us/phoenix/issues/102": issue(
		102,
		"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
		["type:feature", "p1", "status:triaged"],
	),
});

describe("Github.epicLedger — cross-epic dependency resolution at the boundary", () => {
	it.effect("a `requires:` ref to a real non-child issue resolves to externalRefs, not DANGLING_DEP", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const ledger = yield* github.epicLedger(160);
			// #108 is referenced via `requires:` but is not a linked child; it resolves
			// to a real issue, so it rides in externalRefs and is not flagged dangling.
			assert.deepStrictEqual(ledger.externalRefs, [108]);
			assert.notInclude(
				validateLedger(ledger).map((d) => d.type),
				"DANGLING_DEP",
			);
		}).pipe((effect) =>
			provide(effect, {
				...xrefResponses(160),
				"repos/kamp-us/phoenix/issues/108": issue(108, "a cross-epic dependency", [
					"type:feature",
					"p2",
					"status:triaged",
				]),
			}),
		),
	);

	it.effect("a `requires:` ref that 404s is left out of externalRefs and still DANGLES", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const ledger = yield* github.epicLedger(161);
			// #108 is unmapped → the probe 404s → it is not resolved, so it dangles.
			assert.deepStrictEqual(ledger.externalRefs, []);
			const dangling = validateLedger(ledger).find((d) => d.type === "DANGLING_DEP");
			assert.isDefined(dangling);
			assert.deepStrictEqual(dangling?.refs, [108]);
		}).pipe((effect) => provide(effect, xrefResponses(161))),
	);
});
