/**
 * Mutation resolvers — the pasaport (identity) write path.
 * See `.patterns/fate-effect-operations.md`; domain rules live in `Pasaport` (ADR 0013).
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	PHOENIX_EMAIL_DELIVERY_ADMIN,
	PHOENIX_USER_BAN,
	PHOENIX_USER_ROLE_ASSIGN,
} from "../../../src/flags/keys.ts";
import {UserId} from "../../lib/ids.ts";
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
	EmailFailingReasonRequired,
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalidErrors,
	UsernameTaken,
} from "./errors.ts";
import {CandidateId} from "./ids.ts";
import {pasaportLive} from "./live.ts";
import {Pasaport} from "./Pasaport.ts";
import {publishPromotion} from "./promote-live.ts";
import {
	toAccountDeletionReceipt,
	toBanState,
	toEmailDeliveryState,
	toPromotionReceipt,
	toRoleState,
} from "./shapers.ts";
import {resolveTandem} from "./tandem.ts";
import {toTrustedUser} from "./trusted-user.ts";
import {
	AccountDeletionReceiptView,
	BanStateView,
	EmailDeliveryStateView,
	PromotionReceiptView,
	RoleStateView,
	UserView,
} from "./views.ts";

/**
 * Dark-ship flags for the three admin write paths below. Safe-default `false`, so a
 * Flagship outage fails each path with the invisible `Denied` a non-admin call gets —
 * an unreleased ban/role-grant/mark can never touch a real account (ADR 0083).
 */
const userBanOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_BAN, false).pipe(provideRequestFlags);
});

const userRoleAssignOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_USER_ROLE_ASSIGN, false).pipe(provideRequestFlags);
});

const emailDeliveryAdminOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_EMAIL_DELIVERY_ADMIN, false).pipe(provideRequestFlags);
});

const SetUsernameInput = Schema.Struct({
	value: Schema.String,
});

const SetDisplayNameInput = Schema.Struct({
	value: Schema.String,
});

/**
 * The exact phrase the client must echo to fire `account.delete` (ADR 0097 §4). Used as
 * a `Schema.Literal`, so a wrong or absent confirmation fails input DECODE and the
 * mutation body never runs.
 */
export const ACCOUNT_DELETE_CONFIRMATION = "hesabımı kalıcı olarak sil";

const DeleteAccountInput = Schema.Struct({
	confirmation: Schema.Literal(ACCOUNT_DELETE_CONFIRMATION),
});

// No `tier` arg by design: `yazar` is the only destination the server writes (#1203),
// so a client can never request a target tier.
const PromoteInput = Schema.Struct({
	userId: UserId,
});

const VouchInput = Schema.Struct({
	candidateId: CandidateId,
});

// No voucher arg: the voucher is the discharged-`Vouch` actor, so a yazar can only
// withdraw their OWN vouch for `candidateId`.
const WithdrawVouchInput = Schema.Struct({
	candidateId: CandidateId,
});

// `expiresAt` is epoch-millis; null/omitted means permanent. No `actor` arg — the acting
// admin comes from the discharged `Admin` grant, so a ban is always audited against its
// real author.
const BanUserInput = Schema.Struct({
	userId: UserId,
	reason: Schema.String,
	expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
});

const UnbanUserInput = Schema.Struct({
	userId: UserId,
});

// No `actor` arg — the acting admin comes from the discharged `Admin` grant, so a role
// change is always audited against its real author.
const SetRoleInput = Schema.Struct({
	userId: UserId,
	role: Schema.Literals(["member", "moderator"]),
});

// No `address` arg — the target's address is server-resolved from its id, so an admin
// can't mark an arbitrary address.
const MarkEmailFailingInput = Schema.Struct({
	userId: UserId,
	reason: Schema.String,
});

const ClearEmailFailingInput = Schema.Struct({
	userId: UserId,
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
			return yield* toTrustedUser({
				id: result.userId,
				email: user.email,
				name: result.displayName,
				image: result.image,
				username: result.username,
			});
		}),
	),

	// The target is ALWAYS the caller (`user.id`), never an arg, so renaming someone else
	// is unrepresentable. Classified `fanned: false`: the publish below reconciles the
	// owner's own `User` entity, not a Post/Comment/Definition connection — denormalized
	// bylines re-resolve on the next read via `stampAuthorIdentity`.
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
			const live = pasaportLive(yield* WorkerLivePublisher);
			yield* live.user.update(result.userId, {changed: ["name"], data: trusted});
			return trusted;
		}),
	),

	// Account deletion = anonymize-to-`@[silinen]` (ADR 0097). The target is ALWAYS the
	// caller — there is no "delete user X" arg, so deleting someone else is
	// unrepresentable at this surface.
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

	"user.promote": Fate.mutation(
		{
			input: PromoteInput,
			type: PromotionReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("user.promote")(function* ({input}) {
			return yield* requireModeration(promoteGated(input));
		}),
	),

	// `requireVouch` admits yazars only, so a çaylak can't vouch and a yazar self-vouch is
	// inert (already yazar) — self-promotion is impossible across both paths.
	"user.vouch": Fate.mutation(
		{
			input: VouchInput,
			type: PromotionReceiptView,
			error: Schema.Union([RequiresLevel, VouchLimitReached]),
		},
		Effect.fn("user.vouch")(function* ({input}) {
			return yield* requireVouch(vouchGated(input));
		}),
	),

	"user.withdrawVouch": Fate.mutation(
		{
			input: WithdrawVouchInput,
			type: PromotionReceiptView,
			error: Schema.Union([RequiresLevel]),
		},
		Effect.fn("user.withdrawVouch")(function* ({input}) {
			return yield* requireVouch(withdrawGated(input));
		}),
	),

	// This write is only the AUDIT record. Enforcement — refusing the banned user's
	// existing sessions — happens at `Pasaport.validateSession`, not here.
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

	// Writes the `moderates` relation tuple (`moderator` grants, `member` revokes) plus an
	// audited `user_role_event`. Classified `fanned: false`: an identity/authority surface,
	// not a subscribed content connection (mirrors `user.banUser`).
	"user.setRole": Fate.mutation(
		{
			input: SetRoleInput,
			type: RoleStateView,
			error: Schema.Union([Denied, UserNotFound]),
		},
		Effect.fn("user.setRole")(function* ({input}) {
			if (!(yield* userRoleAssignOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(setRoleGated(input));
		}),
	),

	// Appends to the SAME `email_delivery_event` log the send-time capture feeds — one
	// audit trail, one projection. Classified `fanned: false` (mirrors `user.banUser`).
	"emailDelivery.mark": Fate.mutation(
		{
			input: MarkEmailFailingInput,
			type: EmailDeliveryStateView,
			error: Schema.Union([Denied, UserNotFound, EmailFailingReasonRequired]),
		},
		Effect.fn("emailDelivery.mark")(function* ({input}) {
			if (!(yield* emailDeliveryAdminOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(markEmailFailingGated(input));
		}),
	),

	"emailDelivery.clear": Fate.mutation(
		{
			input: ClearEmailFailingInput,
			type: EmailDeliveryStateView,
			error: Schema.Union([Denied, UserNotFound]),
		},
		Effect.fn("emailDelivery.clear")(function* ({input}) {
			if (!(yield* emailDeliveryAdminOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(clearEmailFailingGated(input));
		}),
	),
};

// Post-gate bodies: runnable only with an `Admin` `Grant` in R, and `adminOf(grant)` is
// the authority-checked actor id the audit row is stamped with — so an admin write is
// never attributed to a client-supplied identity.
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

const unbanGated = Effect.fn("user.unbanGated")(function* (input: typeof UnbanUserInput.Type) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const pasaport = yield* Pasaport;
	const state = yield* pasaport.unbanUser({userId: input.userId, actorId});
	return toBanState(input.userId, state);
});

const setRoleGated = Effect.fn("user.setRoleGated")(function* (input: typeof SetRoleInput.Type) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const pasaport = yield* Pasaport;
	const {role} = yield* pasaport.setRole({userId: input.userId, actorId, role: input.role});
	return toRoleState(input.userId, role);
});

const markEmailFailingGated = Effect.fn("emailDelivery.markGated")(function* (
	input: typeof MarkEmailFailingInput.Type,
) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const reason = input.reason.trim();
	if (reason.length === 0) {
		return yield* new EmailFailingReasonRequired({message: "İşaretleme gerekçesi zorunludur."});
	}
	const pasaport = yield* Pasaport;
	const {address, state} = yield* pasaport.markEmailFailing({
		userId: input.userId,
		actorId,
		reason,
	});
	return toEmailDeliveryState(address, state);
});

const clearEmailFailingGated = Effect.fn("emailDelivery.clearGated")(function* (
	input: typeof ClearEmailFailingInput.Type,
) {
	const grant = yield* Admin;
	const actorId = yield* adminOf(grant);
	const pasaport = yield* Pasaport;
	const {address, state} = yield* pasaport.clearEmailFailing({userId: input.userId, actorId});
	return toEmailDeliveryState(address, state);
});

// `yield* Moderate` IS the authority gate: promoting without a discharged grant is a
// compile error (ADR 0107).
const promoteGated = Effect.fn("user.promoteGated")(function* (input: typeof PromoteInput.Type) {
	yield* Moderate;
	const pasaport = yield* Pasaport;
	const {promoted, sweep} = yield* pasaport.promoteToYazar({userId: input.userId});
	// Both keyed on `promoted`, so an already-yazar no-op notifies and publishes nothing.
	// Both are infallible (failures swallowed inside the emitter/publisher), so neither
	// can fail the committed flip.
	if (promoted) {
		yield* notifyPromotion({userId: input.userId});
		yield* publishPromotion(input.userId, sweep);
	}
	return toPromotionReceipt({userId: input.userId, promoted, vouchRecorded: false});
});

// The concurrent-vouch cap is enforced atomically INSIDE `VouchLedger.castVouch` (#1362);
// this body only maps the outcome, and must not re-derive the cap from an active count.
// `resolveTandem` is the SAME promotion path the karma side (#1288) fires, so ordering
// doesn't matter: an over-bar vouch promotes now, a below-bar one waits for karma.
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
	// Only a RECORDED vouch notifies — the idempotent `alreadyVouched` re-vouch must not.
	if (outcome === "recorded") {
		yield* notifyKefil({candidateId: input.candidateId, voucherId});
	}
	return toPromotionReceipt({
		userId: input.candidateId,
		promoted,
		vouchRecorded: outcome === "recorded",
	});
});

// Withdrawing the only active vouch before the karma bar is crossed is what prevents a
// later karma-side promotion: `resolveTandem` then reads no active vouch.
const withdrawGated = Effect.fn("user.withdrawGated")(function* (
	input: typeof WithdrawVouchInput.Type,
) {
	const grant = yield* Vouch;
	const voucherId = yield* voucherOf(grant);

	const ledger = yield* VouchLedger;
	yield* ledger.withdraw({voucherId, candidateId: input.candidateId});

	return toPromotionReceipt({userId: input.candidateId, promoted: false, vouchRecorded: false});
});
