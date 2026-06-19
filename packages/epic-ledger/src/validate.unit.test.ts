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

	it("a non-child ref resolved as a cross-epic edge (externalRefs) is NOT a dangling dep", () => {
		// #108 is referenced via `requires:` but is not a child of this epic; the IO
		// boundary resolved it to a real issue, so it rides in externalRefs and the
		// floor must let it through — a legitimate cross-epic gating edge.
		const l = ledger({
			epic: epic({
				dependencies: graph({
					nodes: [101, 108],
					edges: [{child: 101, requires: 108}],
				}),
			}),
			children: [child(101)],
			externalRefs: [108],
		});
		assert.notInclude(typesOf(l), "DANGLING_DEP");
	});

	it("a non-child ref absent from externalRefs still dangles (the typo/deleted case)", () => {
		const l = ledger({
			epic: epic({
				dependencies: graph({nodes: [101, 108, 999], edges: []}),
			}),
			children: [child(101)],
			externalRefs: [108], // #108 resolved; #999 did not
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

	it("MISSING_CONTAINMENT when a type:feature child carries no containment marker (cycle doc present)", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {containment: undefined})],
		});
		const missing = validateLedger(l).find((d) => d.type === "MISSING_CONTAINMENT");
		assert.isDefined(missing);
		assert.deepStrictEqual(missing?.refs, [101]);
	});

	it("a type:feature child with `flag` containment is NOT a MISSING_CONTAINMENT", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {containment: "flag"})],
		});
		assert.notInclude(typesOf(l), "MISSING_CONTAINMENT");
	});

	it("a type:feature child with `exempt` containment is NOT a MISSING_CONTAINMENT", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {containment: "exempt"})],
		});
		assert.notInclude(typesOf(l), "MISSING_CONTAINMENT");
	});

	it("an explicit `none` containment on a type:feature child IS a MISSING_CONTAINMENT (cycle doc present)", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {containment: "none"})],
		});
		const missing = validateLedger(l).find((d) => d.type === "MISSING_CONTAINMENT");
		assert.isDefined(missing);
		assert.deepStrictEqual(missing?.refs, [101]);
	});

	it("a non-feature child with no containment marker is NOT gated — only type:feature is", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [
				child(101, {labels: ["type:chore", "p1", "status:triaged"], containment: undefined}),
			],
		});
		assert.notInclude(typesOf(l), "MISSING_CONTAINMENT");
	});

	it("MISSING_CONTAINMENT is a no-op when the repo has no cycle doc (graceful absence)", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {containment: undefined})],
			cycleDocPresent: false,
		});
		assert.notInclude(typesOf(l), "MISSING_CONTAINMENT");
	});

	it("MISSING_STORY when a linked child has no `**Stories:**` reference", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {stories: undefined})],
		});
		const missing = validateLedger(l).find((d) => d.type === "MISSING_STORY");
		assert.isDefined(missing);
		assert.deepStrictEqual(missing?.refs, [101]);
	});

	it("the pure-infra marker (stories: []) is not a MISSING_STORY", () => {
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {stories: []})],
		});
		assert.notInclude(typesOf(l), "MISSING_STORY");
	});

	it("MISSING_STORIES_SECTION when the epic declares no stories — and per-child MISSING_STORY is suppressed", () => {
		const l = ledger({
			epic: epic({stories: [], dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {stories: undefined})],
		});
		const types = typesOf(l);
		// the epic-level root-cause defect fires...
		assert.include(types, "MISSING_STORIES_SECTION");
		// ...and the noisy per-child MISSING_STORY does NOT (nothing to trace to)
		assert.notInclude(types, "MISSING_STORY");
		const defect = validateLedger(l).find((d) => d.type === "MISSING_STORIES_SECTION");
		assert.deepStrictEqual(defect?.refs, [100]);
	});

	it("UNCOVERED_STORY when a declared story is covered by no child", () => {
		const l = ledger({
			epic: epic({stories: [1, 2], dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {stories: [1]})],
		});
		const uncovered = validateLedger(l).find((d) => d.type === "UNCOVERED_STORY");
		assert.isDefined(uncovered);
		assert.deepStrictEqual(uncovered?.refs, [2]);
	});

	it("a fully-covered story set yields zero story defects", () => {
		const l = ledger({
			epic: epic({stories: [1, 2], dependencies: graph({nodes: [101, 102], edges: []})}),
			children: [child(101, {stories: [1]}), child(102, {stories: [2]})],
		});
		const types = typesOf(l);
		assert.notInclude(types, "UNCOVERED_STORY");
		assert.notInclude(types, "MISSING_STORY");
	});

	it("each of the closed defect types is producible", () => {
		const produced = new Set<DefectType>();

		produced.add("MISSING_DEPS_SECTION");
		const cyclic = ledger({
			epic: epic({
				stories: [1, 7],
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
				child(103, {
					acceptanceCriteriaCount: 0,
					labels: ["status:needs-triage"],
					stories: undefined,
				}),
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
		// a story-less epic (WITH a child, so it has scope) produces MISSING_STORIES_SECTION
		for (const t of typesOf(
			ledger({
				epic: epic({stories: [], dependencies: graph({nodes: [101], edges: []})}),
				children: [child(101, {stories: undefined})],
			}),
		)) {
			produced.add(t);
		}
		// a type:feature child with no containment marker (cycle doc present) produces MISSING_CONTAINMENT
		for (const t of typesOf(
			ledger({
				epic: epic({dependencies: graph({nodes: [101], edges: []})}),
				children: [child(101, {containment: undefined})],
			}),
		)) {
			produced.add(t);
		}
		// a childless epic produces the zero-scope=fail self-assertion (ADR 0092)
		for (const t of typesOf(ledger({epic: epic({stories: []}), children: []}))) produced.add(t);

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

	it("permuted story / child order yields identical story defects and signature", () => {
		const make = (
			declared: ReadonlyArray<number>,
			children: ReturnType<typeof child>[],
		): EpicLedger =>
			ledger({
				epic: epic({stories: declared, dependencies: graph({nodes: [101, 102], edges: []})}),
				children,
			});
		const a = make([1, 2, 3], [child(101, {stories: [2, 1]}), child(102, {stories: undefined})]);
		const b = make([3, 2, 1], [child(102, {stories: undefined}), child(101, {stories: [1, 2]})]);
		assert.deepStrictEqual(validateLedger(a), validateLedger(b));
		assert.strictEqual(ledgerSignature(a), ledgerSignature(b));
		const types = validateLedger(a).map((d) => d.type);
		assert.include(types, "UNCOVERED_STORY");
		assert.include(types, "MISSING_STORY");
	});

	it("permuted child order yields identical MISSING_CONTAINMENT defects and signature", () => {
		const make = (children: ReturnType<typeof child>[]): EpicLedger =>
			ledger({
				epic: epic({dependencies: graph({present: true, nodes: [101, 102], edges: []})}),
				children,
			});
		const a = make([child(101, {containment: undefined}), child(102, {containment: undefined})]);
		const b = make([child(102, {containment: undefined}), child(101, {containment: undefined})]);
		assert.deepStrictEqual(validateLedger(a), validateLedger(b));
		assert.strictEqual(ledgerSignature(a), ledgerSignature(b));
		assert.strictEqual(validateLedger(a).filter((d) => d.type === "MISSING_CONTAINMENT").length, 2);
	});
});

// The zero-scope=fail self-assertion (formats §ZS / ADR 0092), demonstrated on the floor:
// a relevant input that yields zero scope (a childless epic) FAILs closed, while an input
// that genuinely HAS scope (≥1 child) is judged on its merits — a clean ledger is a PASS,
// not swept into the zero-match FAIL. This is the convention's first adoption.
describe("validateLedger — zero-scope=fail self-assertion (ADR 0092)", () => {
	it("a relevant-but-zero-match input (epic with zero children) FAILs CLOSED with ZERO_SCOPE", () => {
		// The floor's scope IS the children it scans; an epic that declares none gave it nothing
		// to validate, so "scanned nothing" must be a FAIL, never a silent clean PASS.
		const l = ledger({
			epic: epic({number: 100, dependencies: graph({present: true, nodes: [], edges: []})}),
			children: [],
		});
		const defects = validateLedger(l);
		assert.deepStrictEqual(
			defects.map((d) => d.type),
			["ZERO_SCOPE"],
		);
		assert.deepStrictEqual(defects[0]?.refs, [100]);
		assert.strictEqual(isPickable(l), false);
		assert.match(ledgerSignature(l), /^ZERO_SCOPE:100/);
	});

	it("ZERO_SCOPE is the single legible root cause — it suppresses every per-child/dep defect", () => {
		// Even with a missing `## Dependencies` section, a childless epic emits ONLY ZERO_SCOPE:
		// the per-child and dependency checks are vacuous on zero children, so the one epic-level
		// finding is the root cause rather than a noisy pile of downstream defects.
		const l = ledger({
			epic: epic({
				number: 100,
				stories: [],
				dependencies: graph({present: false, nodes: [], edges: []}),
			}),
			children: [],
		});
		assert.deepStrictEqual(
			validateLedger(l).map((d) => d.type),
			["ZERO_SCOPE"],
		);
	});

	it("an explicit not-applicable scope (a clean ledger WITH children) is NOT a zero-match FAIL", () => {
		// The convention's facet #3: a gate with genuine scope is judged on its merits. A clean
		// two-child ledger has positive scope and zero defects, so it PASSes — it must never be
		// swept into the ZERO_SCOPE FAIL, which is reserved for the scanned-nothing case.
		const l = cleanLedger();
		const types = validateLedger(l).map((d) => d.type);
		assert.notInclude(types, "ZERO_SCOPE");
		assert.deepStrictEqual(validateLedger(l), []);
		assert.strictEqual(isPickable(l), true);
	});

	it("a single-child ledger with a real defect FAILs on that defect, not on ZERO_SCOPE", () => {
		// Positive scope (1 child) ⇒ the floor scans it and reports the real defect (ZERO_AC),
		// proving ZERO_SCOPE fires ONLY on an empty scope, never as a catch-all for any failure.
		const l = ledger({
			epic: epic({dependencies: graph({nodes: [101], edges: []})}),
			children: [child(101, {acceptanceCriteriaCount: 0})],
		});
		const types = validateLedger(l).map((d) => d.type);
		assert.notInclude(types, "ZERO_SCOPE");
		assert.include(types, "ZERO_AC");
	});
});
