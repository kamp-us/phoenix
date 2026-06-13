import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit} from "effect";
import {decodeEpicLedger} from "./github.ts";
import {validateLedger} from "./validate.ts";

const epicJson = {
	number: 100,
	title: "the epic",
	labels: [{name: "type:epic"}, {name: "p1"}, {name: "status:triaged"}],
	body: ["## Dependencies", "### Phase 1", "- #101 — a", "- #102 — b (requires: #101)"].join("\n"),
};

const childJson = (number: number, body: string, labels: string[]) => ({
	number,
	title: `child #${number}`,
	labels: labels.map((name) => ({name})),
	body,
});

describe("decodeEpicLedger — the GitHub trust boundary", () => {
	it.effect("decodes well-formed GitHub JSON into a clean EpicLedger", () =>
		Effect.gen(function* () {
			const ledger = yield* decodeEpicLedger({
				epic: epicJson,
				children: [
					childJson(101, "### Acceptance criteria\n- [ ] ac one", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(102, "### Acceptance criteria\n- [ ] ac one\n- [x] ac two", [
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
			assert.strictEqual(ledger.children.length, 2);
			assert.strictEqual(ledger.children[0]?.acceptanceCriteriaCount, 1);
			assert.strictEqual(ledger.children[1]?.acceptanceCriteriaCount, 2);
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
			assert.strictEqual(ledger.children[0]?.acceptanceCriteriaCount, 0);
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
					childJson(102, "### Acceptance criteria\n- [ ] ac", [
						"type:feature",
						"p1",
						"status:triaged",
					]),
					childJson(101, "### Acceptance criteria\n- [ ] ac", [
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
});
