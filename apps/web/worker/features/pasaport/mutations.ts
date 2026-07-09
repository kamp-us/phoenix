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
import {PHOENIX_AUTHORSHIP_LOOP, PHOENIX_USER_BAN} from "../../../src/flags/keys.ts";
import {notifyKefil, notifyPromotion} from "../bildirim/rite-emitters.ts";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Admin, adminOf, requireAdmin} from "../kunye/admin.ts";
import {Denied, RequiresLevel, VouchLimitReached} from "../kunye/errors.ts";
import {Moderate, requireModeration} from "../kunye/moderate.ts";
import {VOUCH_CONCURRENT_CAP} from "../kunye/standing.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {requireVouch, Vouch, voucherOf} from "../kunye/vouch.ts";
import {
	BanReasonRequired,
	DisplayNameEmpty,
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalidErrors,
	UsernameTaken,
} from "./errors.ts";
import {pasaportLive} from "./live.ts";
import {Pasaport} from "./Pasaport.ts";
import {publishPromotion} from "./promote-live.ts";
import {toAccountDeletionReceipt, toBanState, toPromotionReceipt} from "./shapers.ts";
import {resolveTandem} from "./tandem.ts";
import {toTrustedUser} from "./trusted-user.ts";
import {AccountDeletionReceiptView, BanStateView, PromotionReceiptView, UserView} from "./views.ts";

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

/**
 * Is the #970 user-ban dark-ship flag on for this request? Safe-default `false`
 * (dark), the `funnel.summary` idiom: with the flag off (default / Flagship outage)
 * the ban path fails the invisible `Denied` exactly like a non-admin call, so an
 * unreleased ban can never refuse a real user's session (ADR 0083).
 */
const userBanOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_BAN, false).pipe(provideRequestFlags);
});

const SetUsernameInput = Schema.Struct({
	value: Schema.String,
});

const SetDisplayNameInput = Schema.Struct({
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

// Withdraw names the same target as a vouch — the voucher is the discharged-`Vouch`
// actor, never an arg, so a yazar can only withdraw their OWN vouch for `candidateId`.
const WithdrawVouchInput = Schema.Struct({
	candidateId: Schema.String,
});

// Ban a target account by id: a `reason` (required — enforced non-empty in the gated
// body, `BanReasonRequired`) and an OPTIONAL `expiresAt` epoch-millis (null/omitted =
// permanent). No `actor` arg — the acting admin is the discharged `Admin` grant's id,
// never client-supplied, so a ban is always audited against its real author.
const BanUserInput = Schema.Struct({
	userId: Schema.String,
	reason: Schema.String,
	expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
});

const UnbanUserInput = Schema.Struct({
	userId: Schema.String,
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
			// email comes from the session, the rest from the service result; the trusted
			// standing (tier + moderator signal) and the `User` shape come from the one
			// shared `toTrustedUser` home `me` also routes through (#1297/#1320).
			return yield* toTrustedUser({
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			});
		}),
	),

	// Change the görünen ad (display name). The write-through half of #2154:
	// `Pasaport.setDisplayName` updates `user.name` AND `user_profile.display_name`
	// in lockstep, so a display-name edit reaches the stamped column every author
	// byline reads (the one-shot-sync defect: display_name was only ever written at
	// setUsername-time). `CurrentUser.required` gates it (anonymous → `UNAUTHORIZED`);
	// the target is ALWAYS the caller (`user.id`), never an arg, so renaming someone
	// else is unrepresentable. Domain validation (empty-name floor) lives in the
	// service (ADR 0013).
	//
	// Publishes a `User` entity reconcile so the owner's OWN open profile/`User` view
	// (the app-lifetime global live pin, ADR 0094 — `User.id === CurrentUser.id`)
	// reflects the new name over `/fate/live` without a reload — the same channel
	// `publishPromotion` uses for a tier flip. This is NOT a fanned-content publish:
	// the write touches the identity row, not a Post/Comment/Definition, so it is
	// classified `fanned: false` in the manifest. Denormalized bylines re-resolve
	// their live identity on the next read (`stampAuthorIdentity`), never over a
	// per-content live frame. Infallible (publisher error channel is `never`).
	"user.setDisplayName": Fate.mutation(
		{
			input: SetDisplayNameInput,
			type: UserView,
			error: Schema.Union([Unauthorized, DisplayNameEmpty, UserNotFound]),
		},
		Effect.fn("user.setDisplayName")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const pasaport = yield* Pasaport;
			const result = yield* pasaport.setDisplayName({userId: user.id, value: input.value});
			const trusted = yield* toTrustedUser({
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			});
			// `trusted` is already the wire `User` (`toTrustedUser` → `toUser`), so publish
			// it inline as the reconcile data — the same byte-identical shape a fresh fetch
			// yields, masked per-client (the inline-data contract).
			const live = pasaportLive(yield* WorkerLivePublisher);
			yield* live.user.update(result.userId, {changed: ["name"], data: trusted});
			return trusted;
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

	// Author-vouch promotion (#1206, tandem extended in #1289) — the `Vouch` capability
	// gates it (`requireVouch`): a non-yazar → the public `RequiresLevel` (`FORBIDDEN`).
	// A çaylak therefore can't vouch and a yazar self-vouch is inert (already yazar), so
	// self-promotion is impossible across both paths. The concurrent-vouch cap (D5) adds
	// `VouchLimitReached` past the floor. Same #1204 dark-ship gate.
	"user.vouch": Fate.mutation(
		{
			input: VouchInput,
			type: PromotionReceiptView,
			error: Schema.Union([RequiresLevel, VouchLimitReached]),
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

	// Withdraw a vouch (#1289) — the `Vouch`-gated inverse of `user.vouch`: a yazar
	// retracts their own active vouch for `candidateId`, deleting the row and returning
	// the cap slot. Same yazar floor (`requireVouch`) and #1204 dark-ship gate; the
	// receipt is a plain ack (`promoted:false`, `vouchRecorded:false`) — withdrawing
	// never promotes.
	"user.withdrawVouch": Fate.mutation(
		{
			input: WithdrawVouchInput,
			type: PromotionReceiptView,
			error: Schema.Union([RequiresLevel]),
		},
		Effect.fn("user.withdrawVouch")(function* ({input}) {
			if (!(yield* authorshipLoopOn)) {
				return toPromotionReceipt({
					userId: input.candidateId,
					promoted: false,
					vouchRecorded: false,
				});
			}
			return yield* requireVouch(withdrawGated(input));
		}),
	),

	// Ban an account (#970, admin epic #968) — `requireAdmin`-gated, behind the
	// `phoenix-user-ban` dark-ship flag. With the flag off the mutation fails the
	// invisible `Denied` (like a non-admin call), so an unreleased ban never refuses a
	// real session. The write is the AUDIT record (actor from the discharged grant,
	// target, reason, time); enforcement — refusing the banned user's existing
	// sessions — happens at `Pasaport.validateSession`, not here.
	"user.banUser": Fate.mutation(
		{
			input: BanUserInput,
			type: BanStateView,
			error: Schema.Union([Denied, UserNotFound, BanReasonRequired]),
		},
		Effect.fn("user.banUser")(function* ({input}) {
			if (!(yield* userBanOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(banGated(input));
		}),
	),

	// Unban an account (#970) — the `requireAdmin`-gated, flag-gated reversal. Appends
	// an audited `unban` event; the banned user's next request re-validates to a live
	// session. Idempotent (unbanning a not-banned account still reads not-banned).
	"user.unbanUser": Fate.mutation(
		{
			input: UnbanUserInput,
			type: BanStateView,
			error: Schema.Union([Denied, UserNotFound]),
		},
		Effect.fn("user.unbanUser")(function* ({input}) {
			if (!(yield* userBanOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(unbanGated(input));
		}),
	),
};

// The post-gate ban body — runnable only with an `Admin` `Grant` in R
// (`requireAdmin` provides it); `yield* adminOf(grant)` reads the authority-checked
// actor id the audit row is stamped with, so a ban is never attributed to a
// client-supplied identity. A blank reason fails `BanReasonRequired` (a ban must
// carry a reason, epic #968); an unknown target fails `UserNotFound`.
const banGated = Effect.fn("user.banGated")(function* (input: typeof BanUserInput.Type) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const reason = input.reason.trim();
	if (reason.length === 0) {
		return yield* new BanReasonRequired({message: "Yasaklama gerekçesi zorunludur."});
	}
	const pasaport = yield* Pasaport;
	const state = yield* pasaport.banUser({
		userId: input.userId,
		actorId,
		reason,
		expiresAt: input.expiresAt == null ? null : new Date(input.expiresAt),
	});
	return toBanState(input.userId, state);
});

// The post-gate unban body — runnable only with an `Admin` `Grant` in R. Appends the
// audited `unban` (stamped with the discharged admin's id); `UserNotFound` on an
// unknown target.
const unbanGated = Effect.fn("user.unbanGated")(function* (input: typeof UnbanUserInput.Type) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const pasaport = yield* Pasaport;
	const state = yield* pasaport.unbanUser({userId: input.userId, actorId});
	return toBanState(input.userId, state);
});

// The post-gate moderator-promote body — runnable only with a `Moderate` `Grant` in
// R (`requireModeration` provides it); `yield* Moderate` IS the authority gate, so
// promoting without a discharged grant is a compile error (ADR 0107). The tier flip
// + backlog sweep are the atomic `Pasaport.promoteToYazar` (ADR 0013 — domain logic
// in the service). The mod path never records a vouch.
const promoteGated = Effect.fn("user.promoteGated")(function* (input: typeof PromoteInput.Type) {
	yield* Moderate;
	const pasaport = yield* Pasaport;
	const {promoted} = yield* pasaport.promoteToYazar({userId: input.userId});
	// Promotion ceremony (#1696): the mod-direct half of the two promotion sites —
	// notify the promoted member, keyed on `promoted` so a no-op (already-yazar) call
	// notifies nothing. Swallowed inside the emitter, so it can never fail the flip.
	// Live propagation (#1886): publish the new `User` tier so an open profile view
	// reconciles over `/fate/live` without a reload — keyed on `promoted` (a no-op
	// publishes nothing) and infallible (publisher's error channel is `never`).
	if (promoted) {
		yield* notifyPromotion({userId: input.userId});
		yield* publishPromotion(input.userId);
	}
	return toPromotionReceipt({userId: input.userId, promoted, vouchRecorded: false});
});

// The post-gate vouch body — runnable only with a `Vouch` `Grant` in R
// (`requireVouch` provides it). The concurrent-vouch cap (D5) is enforced atomically
// INSIDE `VouchLedger.castVouch` (#1362, ADR 0013) — the resolver no longer reads the
// active count and re-derives the cap, it just maps the outcome: `capReached` →
// `VouchLimitReached`, otherwise the vouch landed (the vouching actor preserved via
// `voucherOf`) and we run the order-independent `resolveTandem` — the SAME promotion
// path the karma side (#1288) fires, so a vouch placed while karma is already over the
// bar promotes immediately and a below-bar vouch is recorded but flips nothing (it waits
// for the karma-side trigger). `alreadyVouched` is the idempotent re-vouch — a success
// that consumes no fresh slot, so `vouchRecorded` is false.
const vouchGated = Effect.fn("user.vouchGated")(function* (input: typeof VouchInput.Type) {
	const grant = yield* Vouch;
	const voucherId = yield* voucherOf(grant);

	const ledger = yield* VouchLedger;
	const {outcome} = yield* ledger.castVouch({
		voucherId,
		candidateId: input.candidateId,
		now: new Date(),
	});
	if (outcome === "capReached") {
		return yield* Effect.fail(
			new VouchLimitReached({
				message: `En fazla ${VOUCH_CONCURRENT_CAP} kişiye aynı anda kefil olabilirsin.`,
				cap: VOUCH_CONCURRENT_CAP,
			}),
		);
	}

	const {promoted} = yield* resolveTandem(input.candidateId);
	// Rite feedback (#1695): a RECORDED vouch (never the idempotent `alreadyVouched`
	// re-vouch) notifies the vouched çaylak — self-suppressed, flag-gated and
	// swallowed inside the emitter, so it can never fail this committed vouch.
	if (outcome === "recorded") {
		yield* notifyKefil({candidateId: input.candidateId, voucherId});
	}
	return toPromotionReceipt({
		userId: input.candidateId,
		promoted,
		vouchRecorded: outcome === "recorded",
	});
});

// The post-gate withdraw body — runnable only with a `Vouch` `Grant` in R. Deletes the
// voucher's own vouch for `candidateId` (returning the cap slot); idempotent, and never
// promotes. Withdrawing the only active vouch before the bar is crossed is what
// prevents a later karma-side promotion — `resolveTandem` then reads no active vouch.
const withdrawGated = Effect.fn("user.withdrawGated")(function* (
	input: typeof WithdrawVouchInput.Type,
) {
	const grant = yield* Vouch;
	const voucherId = yield* voucherOf(grant);

	const ledger = yield* VouchLedger;
	yield* ledger.withdraw({voucherId, candidateId: input.candidateId});

	return toPromotionReceipt({userId: input.candidateId, promoted: false, vouchRecorded: false});
});
