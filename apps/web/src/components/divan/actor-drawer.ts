/**
 * The künye actor-drawer's render + interaction decisions (#1852, ADR 0138), factored
 * DOM-free because `apps/web/src` has no jsdom.
 */

import {countClause, type Message} from "./divanGating";

export type Chamber = "raporlar" | "kefil";

export type DrawerAction =
	| {readonly kind: "toggleDrawer"}
	| {readonly kind: "hopKefil"}
	| {readonly kind: "hopModeration"};

// Uppercase-only bindings: a lowercase key mid-typing must never hop.
export function drawerKeyToAction(key: string): DrawerAction | null {
	switch (key) {
		case "A":
			return {kind: "toggleDrawer"};
		case "V":
			return {kind: "hopKefil"};
		case "M":
			return {kind: "hopModeration"};
		default:
			return null;
	}
}

export function hopTarget(action: DrawerAction): Chamber | null {
	switch (action.kind) {
		case "hopKefil":
			return "kefil";
		case "hopModeration":
			return "raporlar";
		case "toggleDrawer":
			return null;
	}
}

export function drawerDefaultOpen(isDesktop: boolean): boolean {
	return isDesktop;
}

// ADR 0138 §3: in the kefil chamber the mod record informs the human and must never verdict.
export function modRecordVerdicts(chamber: Chamber): boolean {
	return chamber === "raporlar";
}

export interface ActorStanding {
	readonly tier: string | null;
	readonly karma: number | null;
	readonly priorRemovals: number | null;
	readonly distinctReporters: number;
	readonly definitionCount: number | null;
	readonly postCount: number | null;
	readonly commentCount: number | null;
	readonly kefil: boolean | null;
	readonly reportedTargets: number | null;
}

export function actorIdentityLabel(handle: string | null, standing: ActorStanding): string | null {
	const parts: string[] = [];
	const h = handle?.trim();
	if (h) parts.push(`@${h}`);
	if (standing.tier) parts.push(standing.tier);
	if (standing.karma !== null) parts.push(`${standing.karma} karma`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Three independent counts in one line, so each is its own clause and the component
 * interpolates the resolved three into the frame — `.patterns/i18n-catalog.md` under Plurals.
 */
export interface UretimLabel {
	readonly frame: Message;
	readonly definitions: Message;
	readonly posts: Message;
	readonly comments: Message;
}

export function uretimLabel(standing: ActorStanding): UretimLabel | null {
	if (
		standing.definitionCount === null ||
		standing.postCount === null ||
		standing.commentCount === null
	) {
		return null;
	}
	return {
		frame: {key: "divan.actor.uretim"},
		definitions: countClause("definitions", standing.definitionCount),
		posts: countClause("posts", standing.postCount),
		comments: countClause("comments", standing.commentCount),
	};
}

export function kaldirilanLabel(priorRemovals: number | null): Message | null {
	if (priorRemovals === null) return null;
	if (priorRemovals <= 0) return {key: "divan.actor.record.clean"};
	return {key: "divan.actor.record.removed", params: {count: priorRemovals}};
}

// Clamped to ≥1: a real reported target always has at least one reporter. The `one` arm is
// exactly `count === 1` in both catalogs (see `i18n/plural.ts`), so the branch needs no locale.
export function bildirilenLabel(distinctReporters: number): Message {
	const n = Math.max(1, Math.floor(distinctReporters));
	return {
		key: n === 1 ? "divan.actor.reporters.one" : "divan.actor.reporters.other",
		params: {count: n},
	};
}

export function kefilDurumuLabel(kefil: boolean | null): Message | null {
	if (kefil === null) return null;
	return {key: kefil ? "divan.actor.kefil.yes" : "divan.actor.kefil.no"};
}

export function buAktorLabel(reportedTargets: number | null): Message | null {
	if (reportedTargets === null) return null;
	if (reportedTargets <= 1) return {key: "divan.actor.otherReported.none"};
	return {key: "divan.actor.otherReported.some", params: {count: reportedTargets}};
}
