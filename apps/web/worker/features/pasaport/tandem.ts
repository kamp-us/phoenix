/**
 * The **order-independent tandem resolver** (#1289, epic #1202) — the single code path
 * that flips a çaylak → yazar the moment *both* halves of the author-vouch tandem hold:
 * `(≥1 active vouch) AND (net karma ≥ VOUCH_PROMOTION_KARMA_BAR)`. It reads both halves
 * **fresh** from their stores and is **idempotent** (the flip is the atomic, guarded
 * `Pasaport.promoteToYazar`), so it is safe to call from *either* trigger in *either*
 * arrival order:
 *
 *   - the **vouch act** (`user.vouch`, this slice) — fired after a vouch is recorded, so
 *     a vouch placed while karma is already over the bar promotes immediately; and
 *   - the **karma side** (the vote-on-sandboxed path, #1288) — fired after a vote moves
 *     a çaylak's karma, so a bar-crossing vote with an already-active vouch promotes too.
 *
 * Both call THIS resolver, so promotion never depends on whether the vouch or the
 * bar-crossing vote landed first (the correctness property the two symmetric #1289
 * acceptance paths pin). The resolver holds **no authority of its own** — it is not a
 * capability; its only promotion trigger is the completed-tandem invariant it checks
 * here, exactly the "the yazar never holds a promote capability" rule (`.glossary/TERMS.md`:
 * the çaylak→yazar `Level` flip is not a yazar-held right). Callers gate reachability
 * behind the `PHOENIX_AUTHORSHIP_LOOP` dark-ship flag; the resolver itself is
 * unconditional, like the service reads it composes.
 */
import {Effect} from "effect";
import {notifyPromotion} from "../bildirim/rite-emitters.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {VOUCH_PROMOTION_KARMA_BAR} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pasaport} from "./Pasaport.ts";
import {publishPromotion} from "./promote-live.ts";

/**
 * Re-evaluate the tandem for `candidateId` and promote iff both halves hold. Returns
 * `{promoted}` — `true` only when this call's flip fired (a no-op for an already-yazar
 * candidate, since `Pasaport.promoteToYazar` is guarded on `tier = 'çaylak'`). Short-
 * circuits on the vouch half first so a candidate with no active vouch never reads karma.
 */
export const resolveTandem = Effect.fn("pasaport.resolveTandem")(function* (candidateId: string) {
	const ledger = yield* VouchLedger;
	if (!(yield* ledger.hasActiveFor(candidateId))) return {promoted: false};

	const kunye = yield* Kunye;
	const karma = yield* kunye.karmaOf(candidateId);
	if (karma < VOUCH_PROMOTION_KARMA_BAR) return {promoted: false};

	const pasaport = yield* Pasaport;
	const {promoted} = yield* pasaport.promoteToYazar({userId: candidateId});
	// Promotion ceremony (#1696): the tandem-sweep half of the two promotion sites —
	// notify the freshly-promoted çaylak, keyed on `promoted` so an already-yazar
	// re-fire (the idempotent no-op above) notifies nothing. Swallowed inside the
	// emitter, so a bildirim hiccup can never fail this committed tier flip.
	// Live propagation (#1886): the tandem half of the shared post-promote publish —
	// the SAME `publishPromotion` the mod-direct path fires, so both triggers refresh
	// the profile view live. Keyed on `promoted`; infallible (error channel `never`).
	if (promoted) {
		yield* notifyPromotion({userId: candidateId});
		yield* publishPromotion(candidateId);
	}
	return {promoted};
});
