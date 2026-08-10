import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {decodeEpicLedger} from "./github.ts";
import {validateLedger} from "./validate.ts";

const epicJson = {
	number: 100,
	title: "the epic",
	labels: [{name: "type:epic"}, {name: "p1"}, {name: "status:triaged"}],
	body: [
		"### User stories",
		"1. As a planner, I want X.",
		"2. As an agent, I want Y.",
		"",
		"## Dependencies",
		"### Phase 1",
		"- #101 — a",
		"- #102 — b (requires: #101)",
	].join("\n"),
};

// `assignees: []` is what REST actually returns for an unassigned issue — the key is
// always present. A fixture that omitted it would be decoding a payload GitHub does not
// send, and would quietly exercise the unobserved-slot path instead of the real one.
const childJson = (number: number, body: string, labels: string[], assignees: string[] = []) => ({
	number,
	title: `child #${number}`,
	labels: labels.map((name) => ({name})),
	body,
	assignees: assignees.map((login) => ({login})),
});

describe("decodeEpicLedger — the GitHub trust boundary", () => {
	it.effect("decodes well-formed GitHub JSON into a clean EpicLedger", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: epicJson,
				children: [
					childJson(101, "**Stories:** 1\n### Acceptance criteria\n- [ ] ac one", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(102, "**Stories:** 2\n### Acceptance criteria\n- [ ] ac one\n- [x] ac two", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
				],
			});
			assert.strictEqual(ledger.epic.number, 100);
			assert.deepStrictEqual(ledger.epic.labels, ["type:epic", "p1", "status:triaged"]);
			assert.strictEqual(ledger.epic.dependencies.present, true);
			assert.deepStrictEqual(ledger.epic.dependencies.nodes, [101, 102]);
			assert.deepStrictEqual(ledger.epic.dependencies.edges, [{child: 102, requires: 101}]);
			assert.deepStrictEqual(ledger.epic.stories, [1, 2]);
			assert.strictEqual(ledger.children.length, 2);
			assert.strictEqual(ledger.children[0]?.acceptanceCriteriaCount, 1);
			assert.deepStrictEqual(ledger.children[0]?.stories, [1]);
			assert.strictEqual(ledger.children[1]?.acceptanceCriteriaCount, 2);
			assert.deepStrictEqual(ledger.children[1]?.stories, [2]);
			assert.deepStrictEqual(validateLedger(ledger), []);
		}),
	);

	it.effect("a null/absent issue body normalizes to an empty markdown surface", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: {...epicJson, body: null},
				children: [childJson(101, "", ["type:feature", "p1", "status:triaged"])],
			});
			assert.strictEqual(ledger.epic.dependencies.present, false);
			assert.deepStrictEqual(ledger.epic.stories, []);
			assert.strictEqual(ledger.children[0]?.acceptanceCriteriaCount, 0);
			assert.strictEqual(ledger.children[0]?.stories, undefined);
		}),
	);

	// The three states of the assignee slot (#4693). The decode is where "unassigned" and
	// "never read" stop being the same value, so it is where they get separate tests.
	it.effect("an assigned child decodes its logins; an unassigned one decodes an empty list", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: epicJson,
				children: [
					childJson(101, "**Stories:** 1\n- [ ] ac", ["type:feature"], ["a-human"]),
					childJson(102, "**Stories:** 2\n- [ ] ac", ["type:feature"]),
				],
			});
			assert.deepStrictEqual(ledger.children[0]?.assignees, ["a-human"]);
			assert.deepStrictEqual(ledger.children[1]?.assignees, []);
		}),
	);

	it.effect("an absent or null `assignees` key decodes to UNOBSERVED, never to unassigned", () =>
		Effect.gen(function* () {
			const {assignees: _absent, ...noKey} = childJson(101, "**Stories:** 1\n- [ ] ac", [
				"type:feature",
			]);
			const ledger = yield* decodeEpicLedger({
				epic: epicJson,
				children: [noKey, {...childJson(102, "**Stories:** 2\n- [ ] ac", []), assignees: null}],
			});
			assert.strictEqual(ledger.children[0]?.assignees, undefined);
			assert.strictEqual(ledger.children[1]?.assignees, undefined);
			// and the floor says so out loud rather than passing the narrowed payload
			assert.deepStrictEqual(
				validateLedger(ledger)
					.filter((d) => d.type === "UNVERIFIABLE_ASSIGNEE")
					.map((d) => d.refs[0]),
				[101, 102],
			);
		}),
	);

	it.effect("decode FAILS on structurally malformed JSON (missing required fields)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeEpicLedger({epic: {title: "no number"}, children: []}));
			assert.isTrue(Exit.isFailure(exit));
		}),
	);

	it.effect("decode is deterministic — the same JSON yields the same ledger and defects", () =>
		Effect.gen(function* () {
			const input = {
				epic: epicJson,
				children: [
					childJson(102, "**Stories:** 2\n### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(101, "**Stories:** 1\n### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
				],
			};
			const first = yield* decodeEpicLedger(input);
			const second = yield* decodeEpicLedger(input);
			assert.deepStrictEqual(first, second);
			assert.deepStrictEqual(validateLedger(first), validateLedger(second));
		}),
	);

	it.effect("a child with no `**Stories:**` line decodes to MISSING_STORY", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: epicJson,
				children: [
					childJson(101, "**Stories:** 1\n### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(102, "### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
				],
			});
			assert.strictEqual(ledger.children[1]?.stories, undefined);
			const types = validateLedger(ledger).map((d) => d.type);
			assert.include(types, "MISSING_STORY");
			assert.include(types, "UNCOVERED_STORY");
		}),
	);

	it.effect("the pure-infra marker decodes to [] and is not a MISSING_STORY", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: {
					...epicJson,
					body: [
						"### User stories",
						"1. As a planner, I want X.",
						"",
						"## Dependencies",
						"- #101",
						"- #102",
					].join("\n"),
				},
				children: [
					childJson(101, "**Stories:** 1\n### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(
						102,
						"**Stories:** none (pure infra — see What to build)\n### Acceptance criteria\n- [ ] ac",
						["type:feature", "p1", "status:triaged"],
					),
				],
			});
			assert.deepStrictEqual(ledger.children[1]?.stories, []);
			assert.notInclude(
				validateLedger(ledger).map((d) => d.type),
				"MISSING_STORY",
			);
		}),
	);
});
