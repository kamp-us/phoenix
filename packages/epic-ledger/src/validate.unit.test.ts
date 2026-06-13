import {assert, describe, it} from "@effect/vitest";
import {DEFECT_TYPES, type DefectType} from "./Defect.ts";
import {child, cleanLedger, epic, graph, ledger} from "./fixtures.ts";
import type {EpicLedger} from "./Ledger.ts";
import {isPickable, ledgerSignature, validateLedger} from "./validate.ts";

const typesOf = (l: EpicLedger): ReadonlyArray<DefectType> => validateLedger(l).map((d) => d.type);

describe("validateLedger — the clean golden case", () => {
	it("a structurally clean ledger has zero defects and is pickable", () => {
		const l = cleanLedger();
		assert.deepStrictEqual(validateLedger(l), []);
		assert.strictEqual(isPickable(l), true);
		assert.strictEqual(ledgerSignature(l), "clean");
	});
});

describe("validateLedger — each defect type", () => {
	it("MISSING_DEPS_SECTION when the epic has no `## Dependencies`", () => {
		const l = ledger({
			epic: epic({dependencies: graph({present: false, nodes: [], edges: []})}),
			children: [child(101)],
		});
		assert.include(typesOf(l), "MISSING_DEPS_SECTION");
	});

	it("DEP_CYCLE when the dependency graph has a cycle", () => {
		const l = ledger({
			epic: epic({
				dependencies: graph({
					nodes: [101, 102],
					edges: [
						{child: 101, requires: 102},
						{child: 102, requires: 101},
					],
				}),
			}),
			children: [child(101), child(102)],
		});
		const cycle = validateLedger(l).find((d) => d.type === "DEP_CYCLE");
		assert.isDefined(cycle);
		assert.deepStrictEqual(cycle?.refs, [101, 102]);
	});

	it("DANGLING_DEP when `## Dependencies` references a non-linked child", () => {
		const l = ledger({
			epic: epic({
				dependencies: graph({
					nodes: [101, 999],
					edges: [{child: 999, requires: 101}],
				}),
			}),
			children: [child(101)],
		});
		const dangling = validateLedger(l).find((d) => d.type === "DANGLING_DEP");
		assert.isDefined(dangling);
		assert.deepStrictEqual(dangling?.refs, [999]);
	});

	it("does not flag the epic's own number as a dangling dep", () => {
		const l = ledger({
			epic: epic({
				number: 100,
				dependencies: graph({nodes: [100, 101], edges: [{child: 101, requires: 100}]}),
			}),
			children: [child(101)],
		});
		assert.notInclude(typesOf(l), "DANGLING_DEP");
	});

	it("ORPHAN_CHILD when a linked child is absent from `## Dependencies`", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101), child(102)],
		});
		const orphan = validateLedger(l).find((d) => d.type === "ORPHAN_CHILD");
		assert.isDefined(orphan);
		assert.deepStrictEqual(orphan?.refs, [102]);
	});

	it("ZERO_AC when a child has zero acceptance criteria", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {acceptanceCriteriaCount: 0})],
		});
		const zero = validateLedger(l).find((d) => d.type === "ZERO_AC");
		assert.isDefined(zero);
		assert.deepStrictEqual(zero?.refs, [101]);
	});

	it("MISSING_LABEL when a child lacks a required label category", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {labels: ["type:feature"]})],
		});
		const missing = validateLedger(l).find((d) => d.type === "MISSING_LABEL");
		assert.isDefined(missing);
		assert.deepStrictEqual(missing?.refs, [101]);
	});

	it("NEEDS_TRIAGE_LABEL when a child still carries status:needs-triage", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {labels: ["type:feature", "p1", "status:needs-triage"]})],
		});
		const needsTriage = validateLedger(l).find((d) => d.type === "NEEDS_TRIAGE_LABEL");
		assert.isDefined(needsTriage);
		assert.deepStrictEqual(needsTriage?.refs, [101]);
	});

	it("each of the closed 7 defect types is producible", () => {
		const produced = new Set<DefectType>();

		produced.add("MISSING_DEPS_SECTION");
		const cyclic = ledger({
			epic: epic({
				dependencies: graph({
					nodes: [101, 102, 103],
					edges: [
						{child: 101, requires: 102},
						{child: 102, requires: 101},
					],
				}),
			}),
			children: [
				child(101),
				child(102),
				child(103, {acceptanceCriteriaCount: 0, labels: ["status:needs-triage"]}),
			],
		});
		for (const d of validateLedger(cyclic)) produced.add(d.type);
		for (const t of typesOf(
			ledger({
				epic: epic({
					dependencies: graph({nodes: [101, 999], edges: [{child: 999, requires: 101}]}),
				}),
				children: [child(101), child(102)],
			}),
		)) {
			produced.add(t);
		}

		for (const t of DEFECT_TYPES) {
			assert.isTrue(produced.has(t), `expected defect type ${t} to be producible`);
		}
	});
});

describe("validateLedger — determinism", () => {
	const permuted = (): EpicLedger => {
		const l = cleanLedger();
		return ledger({
			epic: epic({
				number: l.epic.number,
				dependencies: graph({
					present: true,
					nodes: [102, 101],
					edges: [{child: 102, requires: 101}],
				}),
			}),
			children: [...l.children].reverse(),
		});
	};

	it("permuted child order yields identical defects and signature (clean)", () => {
		const a = cleanLedger();
		const b = permuted();
		assert.deepStrictEqual(validateLedger(a), validateLedger(b));
		assert.strictEqual(ledgerSignature(a), ledgerSignature(b));
	});

	it("permuted child order yields identical defects and signature (dirty)", () => {
		const make = (children: ReturnType<typeof child>[]): EpicLedger =>
			ledger({
				epic: epic({
					dependencies: graph({
						present: true,
						nodes: [101, 102, 103],
						edges: [{child: 103, requires: 101}],
					}),
				}),
				children,
			});
		const a = make([
			child(101, {acceptanceCriteriaCount: 0}),
			child(102, {labels: ["type:feature"]}),
			child(103),
		]);
		const b = make([
			child(103),
			child(102, {labels: ["type:feature"]}),
			child(101, {acceptanceCriteriaCount: 0}),
		]);
		assert.deepStrictEqual(validateLedger(a), validateLedger(b));
		assert.strictEqual(ledgerSignature(a), ledgerSignature(b));
		assert.isAbove(validateLedger(a).length, 0);
	});

	it("defects are sorted by canonical defect-type rank then ref", () => {
		const l = ledger({
			epic: epic({
				dependencies: graph({
					present: true,
					nodes: [101, 102, 103],
					edges: [{child: 103, requires: 101}],
				}),
			}),
			children: [
				child(103),
				child(101, {acceptanceCriteriaCount: 0}),
				child(102, {labels: ["type:feature"]}),
			],
		});
		const defects = validateLedger(l);
		const rank = (t: DefectType) => DEFECT_TYPES.indexOf(t);
		for (let i = 1; i < defects.length; i += 1) {
			const prev = defects[i - 1];
			const curr = defects[i];
			assert.isDefined(prev);
			assert.isDefined(curr);
			if (prev && curr) {
				const order =
					rank(prev.type) - rank(curr.type) || (prev.refs[0] ?? 0) - (curr.refs[0] ?? 0);
				assert.isAtMost(order, 0);
			}
		}
	});

	it("ledgerSignature omits messages — same defect set, same signature regardless of wording", () => {
		const l = cleanLedger();
		const dirty = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {acceptanceCriteriaCount: 0})],
		});
		assert.strictEqual(ledgerSignature(l), "clean");
		assert.match(ledgerSignature(dirty), /^ZERO_AC:101/);
	});
});
