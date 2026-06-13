import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Ref} from "effect";
import {child, epic, ledger} from "./fixtures.ts";
import {Github} from "./github.ts";
import type {EpicLedger} from "./Ledger.ts";
import {RePlanner, runConvergenceLoop} from "./loop.ts";

const EPIC = 400;

/** A ledger with `n` ZERO_AC defects (children #501..#50n with no acceptance criteria). */
const ledgerWithDefects = (n: number): EpicLedger => {
	const numbers = Array.from({length: Math.max(n, 1)}, (_, i) => 501 + i);
	return ledger({
		epic: epic({
			number: EPIC,
			stories: [1],
			dependencies: {present: true, nodes: numbers, edges: []},
		}),
		children: numbers.map((num, i) =>
			child(num, {
				labels: ["type:feature", "p1", "status:planned"],
				// the first `n` children have zero ACs (defects); the rest are clean
				acceptanceCriteriaCount: i < n ? 0 : 1,
				stories: [1],
			}),
		),
	});
};

/** A fully clean, story-covered ledger (zero defects) whose children are planned. */
const cleanLedger = (): EpicLedger =>
	ledger({
		epic: epic({
			number: EPIC,
			stories: [1],
			dependencies: {present: true, nodes: [501], edges: []},
		}),
		children: [child(501, {labels: ["type:feature", "p1", "status:planned"], stories: [1]})],
	});

interface Recorded {
	flips: number[];
	comments: Array<{readonly issue: number; readonly body: string}>;
	parks: number[];
	rePlans: number;
}

const emptyRecord = (): Recorded => ({flips: [], comments: [], parks: [], rePlans: 0});

/**
 * Wire a faked `Github` + `RePlanner` over a *sequence* of ledgers — one per gate
 * pass. A `Ref` cursor advances on each `epicLedger` read, so successive passes
 * see successive ledgers (the faked verify sequence the test scripts). `rePlan`
 * records its call count and otherwise no-ops (the next read advances the
 * sequence on its own).
 */
const harness = (sequence: ReadonlyArray<EpicLedger>, rec: Ref.Ref<Recorded>) =>
	Effect.gen(function* () {
		const cursor = yield* Ref.make(0);
		const github = Layer.succeed(Github)({
			epicLedger: () =>
				Effect.gen(function* () {
					const i = yield* Ref.getAndUpdate(cursor, (n) => Math.min(n + 1, sequence.length - 1));
					return sequence[Math.min(i, sequence.length - 1)] ?? sequence[sequence.length - 1]!;
				}),
			flipChildToTriaged: (n) => Ref.update(rec, (r) => ({...r, flips: [...r.flips, n]})),
			postComment: (issue, body) =>
				Ref.update(rec, (r) => ({...r, comments: [...r.comments, {issue, body}]})),
			parkNeedsInfo: (n) => Ref.update(rec, (r) => ({...r, parks: [...r.parks, n]})),
		});
		const replanner = Layer.succeed(RePlanner)({
			rePlan: () => Ref.update(rec, (r) => ({...r, rePlans: r.rePlans + 1})),
		});
		return Layer.merge(github, replanner);
	});

describe("runConvergenceLoop — re-plan while shrinking, park on stall (#166)", () => {
	it.effect("shrink → zero converges to a clean PASS and flips the children", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			// 3 defects → 2 → 1 → 0 (clean): strictly shrinking, then passes
			const sequence = [
				ledgerWithDefects(3),
				ledgerWithDefects(2),
				ledgerWithDefects(1),
				cleanLedger(),
			];
			const layers = yield* harness(sequence, rec);
			const outcome = yield* runConvergenceLoop(EPIC).pipe(Effect.provide(layers));
			const r = yield* Ref.get(rec);

			assert.strictEqual(outcome._tag, "converged");
			if (outcome._tag === "converged") {
				assert.deepStrictEqual(outcome.flipped, [501]);
			}
			// re-planned three times (after each of the three FAILs), then the 4th pass passed
			assert.strictEqual(r.rePlans, 3);
			// the clean pass flipped the one planned child; nothing parked
			assert.deepStrictEqual(r.flips, [501]);
			assert.deepStrictEqual(r.parks, []);
		}),
	);

	it.effect("a repeated ledgerSignature parks the epic at needs-info (no infinite loop)", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			// shrink once (3 → 2), then the SAME 2-defect ledger recurs: a cycle
			const sequence = [ledgerWithDefects(3), ledgerWithDefects(2), ledgerWithDefects(2)];
			const layers = yield* harness(sequence, rec);
			const outcome = yield* runConvergenceLoop(EPIC).pipe(Effect.provide(layers));
			const r = yield* Ref.get(rec);

			assert.strictEqual(outcome._tag, "parked");
			if (outcome._tag === "parked") {
				assert.strictEqual(outcome.reason, "repeated-signature");
				assert.isAbove(outcome.defects.length, 0);
			}
			// parked exactly once, with a diagnostic comment naming unresolved defects
			assert.deepStrictEqual(r.parks, [EPIC]);
			assert.isTrue(r.comments.some((c) => /PARKED/.test(c.body) && /ZERO_AC/.test(c.body)));
			// never flipped a child on a parked epic
			assert.deepStrictEqual(r.flips, []);
		}),
	);

	it.effect("a non-shrinking defect set parks the epic (stall)", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			// 2 → 3: the set grew (didn't shrink) but the signature differs → non-shrinking stall
			const sequence = [ledgerWithDefects(2), ledgerWithDefects(3)];
			const layers = yield* harness(sequence, rec);
			const outcome = yield* runConvergenceLoop(EPIC).pipe(Effect.provide(layers));
			const r = yield* Ref.get(rec);

			assert.strictEqual(outcome._tag, "parked");
			if (outcome._tag === "parked") assert.strictEqual(outcome.reason, "non-shrinking");
			assert.deepStrictEqual(r.parks, [EPIC]);
			assert.deepStrictEqual(r.flips, []);
		}),
	);

	it.effect("converges immediately when the first pass is already clean (no re-plan)", () =>
		Effect.gen(function* () {
			const rec = yield* Ref.make(emptyRecord());
			const layers = yield* harness([cleanLedger()], rec);
			const outcome = yield* runConvergenceLoop(EPIC).pipe(Effect.provide(layers));
			const r = yield* Ref.get(rec);
			assert.strictEqual(outcome._tag, "converged");
			assert.strictEqual(r.rePlans, 0);
			assert.deepStrictEqual(r.flips, [501]);
		}),
	);
});
