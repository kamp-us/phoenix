/**
 * The divan surface's render decisions, factored DOM-free because `apps/web/src` has no
 * jsdom. The gates mirror the backend `requireDivanAccess` disjunction (divan/gate.ts):
 * the divan is reached by yazar OR mod, and the server stays the sole authority — a
 * client gate is a courtesy, and an unauthorized call comes back the invisible denial.
 */
import {TARGET_KINDS, type TargetKind} from "../../../worker/db/target-kind";
import type {Tier} from "../../../worker/features/kunye/standing";
import type {CatalogKey, MessageParams} from "../../i18n";

/**
 * A rendered message a DOM-free module resolves to: the catalog key plus whatever the copy
 * interpolates. The module picks the key, the component calls `t` — see ADR 0347.
 */
export type Message = {readonly key: CatalogKey; readonly params?: MessageParams};

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

/**
 * The vouch trigger's three states (#7373). `done` is the honest end state — the viewer
 * already holds this çaylak's vouch — and it stays a disabled label, never a withdraw
 * control: whether withdrawal gets a surface is a separate product call.
 */
export type VouchTriggerState = "hidden" | "offer" | "done";

export function vouchTriggerState(
	tier: Tier | undefined,
	alreadyVouched: boolean,
): VouchTriggerState {
	if (!vouchVisible(tier)) return "hidden";
	return alreadyVouched ? "done" : "offer";
}

export function vouchTriggerLabel(state: VouchTriggerState): CatalogKey {
	return state === "done" ? "divan.vouch.done" : "divan.vouch.offer";
}

// Keyed off `isModerator`, never `tier`: a dual-role yazar+moderator reads `tier: "yazar"`
// (#1320), so a tier check wrongly hid promote from them.
export function promoteVisible(isModerator: boolean): boolean {
	return isModerator;
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

export function itemKindLabel(kind: TargetKind): CatalogKey {
	switch (kind) {
		case "definition":
			return "divan.kind.definition";
		case "post":
			return "divan.kind.post";
		case "comment":
			return "divan.kind.comment";
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

export function promoteOutcomeMessage(outcome: PromoteOutcome): CatalogKey {
	switch (outcome) {
		case "promoted":
			return "divan.promote.promoted";
		case "alreadyYazar":
			return "divan.promote.alreadyYazar";
		case "denied":
			return "divan.promote.denied";
		case "error":
			return "divan.action.failed";
	}
}

/**
 * Which promote outcomes warrant re-pulling the review reads (#7036). A flip leaves
 * roster/backlog stale; an "already yazar" answer means the screen was ALREADY stale
 * when pressed (the double-press case), so it refreshes too. A denial or transport
 * error says nothing about the lists — their rendering stays untouched.
 */
export function promoteRefreshWarranted(outcome: PromoteOutcome): boolean {
	return outcome === "promoted" || outcome === "alreadyYazar";
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

/**
 * Which confirm outcomes leave the viewer holding a vouch row. `recorded` covers the
 * idempotent re-vouch too (the server answers `alreadyVouched` with `vouchRecorded: false`
 * and no promotion), so both mean "you are this çaylak's kefil" — which is what the trigger
 * reports. A cap denial, an authority denial and a transport error say nothing landed.
 */
export function vouchLanded(outcome: VouchOutcome): boolean {
	return outcome === "recorded" || outcome === "promoted";
}

export function vouchOutcomeMessage(outcome: VouchOutcome): CatalogKey {
	switch (outcome) {
		case "promoted":
			return "divan.vouch.promoted";
		case "recorded":
			return "divan.vouch.recorded";
		case "limit":
			return "divan.vouch.limit";
		case "denied":
			return "divan.vouch.denied";
		case "error":
			return "divan.action.failed";
	}
}
