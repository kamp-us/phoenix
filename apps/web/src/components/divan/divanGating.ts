/**
 * The divan surface's render decisions, factored DOM-free because `apps/web/src` has no
 * jsdom. The gates mirror the backend `requireDivanAccess` disjunction (divan/gate.ts):
 * the divan is reached by yazar OR mod, and the server stays the sole authority — a
 * client gate is a courtesy, and an unauthorized call comes back the invisible denial.
 */
import {TARGET_KINDS, type TargetKind} from "../../../worker/db/target-kind";
import type {Tier} from "../../../worker/features/kunye/standing";
import {actorLabel} from "../moderation/actor-identity";

/**
 * Denial is provable only when BOTH arms are KNOWN-false. An `undefined` tier (`me` not
 * yet read) is the ambiguous case ⇒ `false`, so the server probe still runs and stays the
 * authority. The short-circuit is layered ON the server gate, never a replacement.
 */
export function divanAccessDefinitelyDenied(
	tier: Tier | undefined,
	isModerator: boolean | undefined,
): boolean {
	return tier !== undefined && tier !== "yazar" && isModerator === false;
}

export function shouldProbeDivanRoster(
	signedIn: boolean,
	tier: Tier | undefined,
	isModerator: boolean | undefined,
): boolean {
	return signedIn && !divanAccessDefinitelyDenied(tier, isModerator);
}

// `requireVouch` is the yazar floor server-side, so a mod who is not a yazar cannot vouch.
export function vouchVisible(tier: Tier | undefined): boolean {
	return tier === "yazar";
}

// Staking on a çaylak you have not opened is unrepresentable — hence `detailOpened`.
export function canVouch(tier: Tier | undefined, detailOpened: boolean): boolean {
	return vouchVisible(tier) && detailOpened;
}

// Keyed off `isModerator`, never `tier`: a dual-role yazar+moderator reads `tier: "yazar"`
// (#1320), so a tier check wrongly hid promote from them.
export function promoteVisible(isModerator: boolean): boolean {
	return isModerator;
}

// See ADR 0147 — one shared handle resolver across the mod surfaces; divan supplies its noun.
export function caylakLabel(displayName: string | null, username: string | null): string {
	return actorLabel(displayName, username, "çaylak");
}

export function parseBacklogItemId(
	id: string,
): {readonly targetKind: TargetKind; readonly targetId: string} | null {
	const sep = id.indexOf(":");
	if (sep <= 0 || sep === id.length - 1) return null;
	const kind = id.slice(0, sep);
	if (!(TARGET_KINDS as ReadonlyArray<string>).includes(kind)) return null;
	return {targetKind: kind as TargetKind, targetId: id.slice(sep + 1)};
}

export function itemKindLabel(kind: TargetKind): string {
	switch (kind) {
		case "definition":
			return "tanım";
		case "post":
			return "gönderi";
		case "comment":
			return "yorum";
	}
}

export type PromoteOutcome = "promoted" | "alreadyYazar" | "denied" | "error";

export function promoteOutcome(
	promoted: boolean | undefined,
	denied: boolean,
	failed: boolean,
): PromoteOutcome {
	if (denied) return "denied";
	if (failed) return "error";
	return promoted ? "promoted" : "alreadyYazar";
}

export function promoteOutcomeMessage(outcome: PromoteOutcome): string {
	switch (outcome) {
		case "promoted":
			return "çaylak yazar oldu.";
		case "alreadyYazar":
			return "kullanıcı zaten yazar.";
		case "denied":
			return "bunu yapma yetkin yok.";
		case "error":
			return "işlem başarısız oldu.";
	}
}

export type VouchOutcome = "promoted" | "recorded" | "limit" | "denied" | "error";

export function vouchOutcome(
	promoted: boolean | undefined,
	code: string | null,
	failed: boolean,
): VouchOutcome {
	if (code === "VOUCH_LIMIT_REACHED") return "limit";
	if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return "denied";
	if (failed) return "error";
	return promoted ? "promoted" : "recorded";
}

export function vouchOutcomeMessage(outcome: VouchOutcome): string {
	switch (outcome) {
		case "promoted":
			return "kefil oldun ve çaylak yazar oldu.";
		case "recorded":
			return "kefil oldun. çaylak yeterli karmaya ulaşınca yazar olacak.";
		case "limit":
			return "en fazla üç kişiye aynı anda kefil olabilirsin.";
		case "denied":
			return "kefil olmak için yazar olmalısın.";
		case "error":
			return "işlem başarısız oldu.";
	}
}
