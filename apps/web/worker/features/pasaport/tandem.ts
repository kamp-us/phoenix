/**
 * The order-independent tandem resolver (#1289): flips çaylak → yazar once both halves
 * hold — `(≥1 active vouch) AND (karma ≥ VOUCH_PROMOTION_KARMA_BAR)`. It reads both fresh
 * and is idempotent, so BOTH triggers (the vouch act, and the karma-moving vote of #1288)
 * call it and promotion never depends on which landed first.
 *
 * It holds no authority of its own — the completed tandem is the only trigger, keeping
 * "the yazar never holds a promote capability" true (`.glossary/TERMS.md`).
 */
import {Effect} from "effect";
import {notifyPromotion} from "../bildirim/rite-emitters.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {VOUCH_PROMOTION_KARMA_BAR} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pasaport} from "./Pasaport.ts";
import {publishPromotion} from "./promote-live.ts";

/** `promoted` is `true` only when THIS call's flip fired, never for an already-yazar. */
export const resolveTandem = Effect.fn("pasaport.resolveTandem")(function* (candidateId: string) {
	const ledger = yield* VouchLedger;
	if (!(yield* ledger.hasActiveFor(candidateId))) return {promoted: false};

	const kunye = yield* Kunye;
	const karma = yield* kunye.karmaOf(candidateId);
	if (karma < VOUCH_PROMOTION_KARMA_BAR) return {promoted: false};

	const pasaport = yield* Pasaport;
	const {promoted, sweep} = yield* pasaport.promoteToYazar({userId: candidateId});
	// Both keyed on `promoted`, so an idempotent re-fire notifies and publishes nothing.
	// Both are infallible, so neither can fail this committed tier flip.
	if (promoted) {
		yield* notifyPromotion({userId: candidateId});
		yield* publishPromotion(candidateId, sweep);
	}
	return {promoted};
});
