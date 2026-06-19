import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref} from "effect";
import {child, cleanLedger, epic, ledger} from "./fixtures.ts";
import {runGate} from "./gate.ts";
import {Github} from "./github.ts";
import type {EpicLedger} from "./Ledger.ts";

/** Every mutation a fake `Github` recorded — the gate's full side-effect trace. */
interface Recorded {
	flips: number[];
	comments: Array<{readonly issue: number; readonly body: string}>;
	parks: number[];
}

/**
 * A fake `Github` that serves a fixed ledger for the epic and records every
 * mutation into a `Ref`, so a test asserts the exact label transitions and that
 * nothing else was touched. The read (`epicLedger`) returns the canned ledger;
 * the mutations append to the record.
 */
const fakeGithub = (served: EpicLedger, rec: Ref.Ref<Recorded>): Layer.Layer<Github> =>
	Layer.succeed(Github)({
		epicLedger: () => Effect.succeed(served),
		flipChildToTriaged: (n) => Ref.update(rec, (r) => ({...r, flips: [...r.flips, n]})),
		postComment: (issue, body) =>
			Ref.update(rec, (r) => ({...r, comments: [...r.comments, {issue, body}]})),
		parkNeedsInfo: (n) => Ref.update(rec, (r) => ({...r, parks: [...r.parks, n]})),
	});

const emptyRecord = (): Recorded => ({flips: [], comments: [], parks: []});

/** A ledger whose two `status:planned` children pass the floor cleanly. */
const cleanPlannedLedger = (): EpicLedger =>
	ledger({
		epic: epic({
			number: 200,
			stories: [1],
			dependencies: {nodes: [201, 202], edges: [{child: 202, requires: 201}], present: true},
		}),
		children: [
			child(201, {labels: ["type:feature", "p1", "status:planned"], stories: [1]}),
			child(202, {labels: ["type:feature", "p1", "status:planned"], stories: [1]}),
		],
	});

describe("runGate — the deterministic review-plan gate action (#164)", () => {
	it.effect("zero defects: flips every planned child to triaged and posts a PASS verdict", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			const verdict = yield* runGate(200).pipe(
				Effect.provide(fakeGithub(cleanPlannedLedger(), rec)),
			);
			const r = yield* Ref.get(rec);

			assert.strictEqual(verdict._tag, "pass");
			if (verdict._tag === "pass") assert.deepStrictEqual(verdict.flipped, [201, 202]);

			// exact label transitions: both planned children flipped, in order
			assert.deepStrictEqual(r.flips, [201, 202]);
			// one verdict comment, on the epic, leading with the PASS marker
			assert.strictEqual(r.comments.length, 1);
			assert.strictEqual(r.comments[0]?.issue, 200);
			assert.match(r.comments[0]?.body ?? "", /review-plan: PASS/);
			// nothing else mutated: no park
			assert.deepStrictEqual(r.parks, []);
		}),
	);

	it.effect("≥1 hard defect: flips nothing and posts a per-defect FAIL verdict", () =>
		Effect.gen(function* () {
			// a child with zero ACs (ZERO_AC) and a missing-deps epic (MISSING_DEPS_SECTION)
			const broken = ledger({
				epic: epic({
					number: 300,
					stories: [],
					dependencies: {present: false, nodes: [], edges: []},
				}),
				children: [
					child(301, {
						labels: ["type:feature", "p1", "status:planned"],
						acceptanceCriteriaCount: 0,
						stories: [],
					}),
				],
			});
			const rec = yield* Ref.make(emptyRecord());
			const verdict = yield* runGate(300).pipe(Effect.provide(fakeGithub(broken, rec)));
			const r = yield* Ref.get(rec);

			assert.strictEqual(verdict._tag, "fail");
			if (verdict._tag === "fail") {
				const types = verdict.defects.map((d) => d.type);
				assert.include(types, "MISSING_DEPS_SECTION");
				assert.include(types, "ZERO_AC");
				assert.isString(verdict.signature);
			}

			// the load-bearing invariant: NO flip occurred
			assert.deepStrictEqual(r.flips, []);
			// exactly one FAIL verdict comment, listing each defect
			assert.strictEqual(r.comments.length, 1);
			assert.match(r.comments[0]?.body ?? "", /review-plan: FAIL/);
			assert.match(r.comments[0]?.body ?? "", /MISSING_DEPS_SECTION/);
			assert.match(r.comments[0]?.body ?? "", /ZERO_AC/);
			// nothing parked, nothing flipped — brief/topology/links untouched by construction
			assert.deepStrictEqual(r.parks, []);
		}),
	);

	it.effect(
		"a clean ledger whose children are already triaged flips nothing but still PASSES",
		() =>
			Effect.gen(function* () {
				const rec = yield* Ref.make(emptyRecord());
				const verdict = yield* runGate(100).pipe(Effect.provide(fakeGithub(cleanLedger(), rec)));
				const r = yield* Ref.get(rec);
				assert.strictEqual(verdict._tag, "pass");
				assert.deepStrictEqual(r.flips, []);
				assert.match(r.comments[0]?.body ?? "", /review-plan: PASS/);
			}),
	);

	// The emit-scope facet of zero-scope=fail (formats §ZS / ADR 0092): the gate is the real
	// consumer — every verdict states what the gate scanned, and a childless epic fails closed.
	it.effect("PASS verdict emits the scanned scope (child count + matched numbers)", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			yield* runGate(200).pipe(Effect.provide(fakeGithub(cleanPlannedLedger(), rec)));
			const r = yield* Ref.get(rec);
			assert.match(r.comments[0]?.body ?? "", /Scanned scope: 2 child\(ren\) — #201, #202/);
		}),
	);

	it.effect("a childless epic FAILs CLOSED with ZERO_SCOPE and emits a zero-child scope line", () =>
		Effect.gen(function* () {
			const childless = ledger({
				epic: epic({number: 400, dependencies: {present: true, nodes: [], edges: []}}),
				children: [],
			});
			const rec = yield* Ref.make(emptyRecord());
			const verdict = yield* runGate(400).pipe(Effect.provide(fakeGithub(childless, rec)));
			const r = yield* Ref.get(rec);

			assert.strictEqual(verdict._tag, "fail");
			if (verdict._tag === "fail") {
				assert.deepStrictEqual(
					verdict.defects.map((d) => d.type),
					["ZERO_SCOPE"],
				);
			}
			// no flip — fail closed
			assert.deepStrictEqual(r.flips, []);
			assert.match(r.comments[0]?.body ?? "", /review-plan: FAIL/);
			assert.match(r.comments[0]?.body ?? "", /ZERO_SCOPE/);
			assert.match(r.comments[0]?.body ?? "", /Scanned scope: 0 child\(ren\) — —/);
		}),
	);
});
