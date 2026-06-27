/**
 * Mutation resolvers — the pasaport (identity) write path. `Fate.mutation` def +
 * `Effect.fn` pairs named `entity.verb` (ADR 0020;
 * `.patterns/fate-effect-operations.md`). Validation, constraints, and domain
 * errors stay in `Pasaport.setUsername` (ADR 0013); `CurrentUser.required` gates
 * the write (anonymous → `UNAUTHORIZED`).
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Denied, RequiresLevel} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {Moderate, requireModeration} from "../kunye/moderate.ts";
import {VOUCH_PROMOTION_KARMA_BAR} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {requireVouch, Vouch, voucherOf} from "../kunye/vouch.ts";
import {UserNotFound, UsernameAlreadySet, UsernameInvalidErrors, UsernameTaken} from "./errors.ts";
import {Pasaport} from "./Pasaport.ts";
import {toAccountDeletionReceipt, toPromotionReceipt, toUser} from "./shapers.ts";
import {AccountDeletionReceiptView, PromotionReceiptView, UserView} from "./views.ts";

/**
 * Is the #1204 authorship-loop dark-ship flag on for this request? The promotion
 * surface is gated behind it (default-off), the way #1205 gated its sandbox write —
 * a Flagship outage or the unflipped default both read `false`, so the loop stays
 * dark until a human flips it at release (ADR 0083).
 */
const authorshipLoopOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_AUTHORSHIP_LOOP, false).pipe(provideRequestFlags);
});

const SetUsernameInput = Schema.Struct({
	value: Schema.String,
});

/**
 * The exact phrase the client must echo to fire `account.delete` (ADR 0097 §4).
 * It is a `Schema.Literal`, so an absent or wrong confirmation is an input-DECODE
 * failure — the mutation body never runs on a malformed/replayed request, and
 * "deleted by accident" is unrepresentable rather than a silent execution. Turkish
 * user-facing copy (the SPA shows it; the user types it back verbatim).
 */
export const ACCOUNT_DELETE_CONFIRMATION = "hesabımı kalıcı olarak sil";

const DeleteAccountInput = Schema.Struct({
	confirmation: Schema.Literal(ACCOUNT_DELETE_CONFIRMATION),
});

// The two promotion inputs each name a target by account id. No `tier` arg exists,
// so a client can never request a target tier — `yazar` is the only destination the
// server writes (#1203), and the path is the only writer.
const PromoteInput = Schema.Struct({
	userId: Schema.String,
});

const VouchInput = Schema.Struct({
	candidateId: Schema.String,
});

export const mutations = {
	"user.setUsername": Fate.mutation(
		{
			input: SetUsernameInput,
			type: UserView,
			error: Schema.Union([
				Unauthorized,
				...UsernameInvalidErrors,
				UsernameTaken,
				UsernameAlreadySet,
				UserNotFound,
			]),
		},
		Effect.fn("user.setUsername")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			const result = yield* pasaport.setUsername({userId: user.id, value: input.value});
			// email comes from the session; the rest from the service result.
			return toUser({
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			});
		}),
	),

	// Account deletion = anonymize-to-`@[silinen]` (ADR 0097). Synchronous, gated
	// by `CurrentUser.required` (anonymous → `UNAUTHORIZED`); the target is ALWAYS
	// the caller (`user.id`) — there is no "delete user X" arg, so anonymizing
	// someone else is unrepresentable at this surface. The typed-confirmation gate
	// lives in `DeleteAccountInput` (a `Schema.Literal`): a wrong/absent token fails
	// input decode before the body runs. The teardown is `Pasaport.anonymizeAccount`
	// (ADR 0013 — domain logic in the service, not the resolver).
	"account.delete": Fate.mutation(
		{
			input: DeleteAccountInput,
			type: AccountDeletionReceiptView,
			error: Unauthorized,
		},
		Effect.fn("account.delete")(function* () {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			yield* pasaport.anonymizeAccount({userId: user.id});
			return toAccountDeletionReceipt();
		}),
	),

	// Direct moderator promotion (#1206) — the `Moderate` capability gates it
	// (`requireModeration`): anonymous or non-moderator → the invisible `Denied`
	// (`UNAUTHORIZED`), so the surface is invisible to non-moderators. Dark-shipped
	// behind the #1204 authorship flag: with the flag off the body short-circuits to
	// an inert receipt (no authority check, no write), so the path is unreachable
	// until a human flips the flag at release.
	"user.promote": Fate.mutation(
		{
			input: PromoteInput,
			type: PromotionReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("user.promote")(function* ({input}) {
			if (!(yield* authorshipLoopOn)) {
				return toPromotionReceipt({userId: input.userId, promoted: false, vouchRecorded: false});
			}
			return yield* requireModeration(promoteGated(input));
		}),
	),

	// Author-vouch promotion (#1206) — the tandem. The `Vouch` capability gates it
	// (`requireVouch`): a non-yazar → the public `RequiresLevel` (`FORBIDDEN`). A
	// çaylak therefore can't vouch and a yazar self-vouch is inert (already yazar),
	// so self-promotion is impossible across both paths. Same #1204 dark-ship gate.
	"user.vouch": Fate.mutation(
		{
			input: VouchInput,
			type: PromotionReceiptView,
			error: Schema.Union([RequiresLevel]),
		},
		Effect.fn("user.vouch")(function* ({input}) {
			if (!(yield* authorshipLoopOn)) {
				return toPromotionReceipt({
					userId: input.candidateId,
					promoted: false,
					vouchRecorded: false,
				});
			}
			return yield* requireVouch(vouchGated(input));
		}),
	),
};

// The post-gate moderator-promote body — runnable only with a `Moderate` `Grant` in
// R (`requireModeration` provides it); `yield* Moderate` IS the authority gate, so
// promoting without a discharged grant is a compile error (ADR 0107). The tier flip
// + backlog sweep are the atomic `Pasaport.promoteToYazar` (ADR 0013 — domain logic
// in the service). The mod path never records a vouch.
const promoteGated = Effect.fn("user.promoteGated")(function* (input: typeof PromoteInput.Type) {
	yield* Moderate;
	const pasaport = yield* Pasaport;
	const {promoted} = yield* pasaport.promoteToYazar({userId: input.userId});
	return toPromotionReceipt({userId: input.userId, promoted, vouchRecorded: false});
});

// The post-gate vouch body — runnable only with a `Vouch` `Grant` in R
// (`requireVouch` provides it). Records the vouch (the vouching actor preserved via
// `voucherOf`), then applies the tandem: promote ONLY when the candidate clears the
// reduced karma bar (`VOUCH_PROMOTION_KARMA_BAR`, read from `user_profile.total_karma`
// via `Kunye.karmaOf`). Below the bar the vouch is still recorded but no tier flips —
// and there is no auto-trigger on a later karma change (the re-evaluation only
// happens on another vouch act), so no karma-AUTO-promotion (North Star #1194).
const vouchGated = Effect.fn("user.vouchGated")(function* (input: typeof VouchInput.Type) {
	const grant = yield* Vouch;
	const voucherId = yield* voucherOf(grant);

	const ledger = yield* VouchLedger;
	const {recorded} = yield* ledger.record({
		voucherId,
		candidateId: input.candidateId,
		now: new Date(),
	});

	const kunye = yield* Kunye;
	const karma = yield* kunye.karmaOf(input.candidateId);

	let promoted = false;
	if (karma >= VOUCH_PROMOTION_KARMA_BAR) {
		const pasaport = yield* Pasaport;
		promoted = (yield* pasaport.promoteToYazar({userId: input.candidateId})).promoted;
	}

	return toPromotionReceipt({userId: input.candidateId, promoted, vouchRecorded: recorded});
});
