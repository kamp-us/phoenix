/**
 * The künye actor-drawer's render + interaction decisions (#1852, ADR 0138), factored
 * DOM-free because `apps/web/src` has no jsdom.
 */

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

export function uretimLabel(standing: ActorStanding): string | null {
	if (
		standing.definitionCount === null ||
		standing.postCount === null ||
		standing.commentCount === null
	) {
		return null;
	}
	return `${standing.definitionCount} tanım · ${standing.postCount} gönderi · ${standing.commentCount} yorum`;
}

export function kaldirilanLabel(priorRemovals: number | null): string | null {
	if (priorRemovals === null) return null;
	if (priorRemovals <= 0) return "temiz";
	return `${priorRemovals} kaldırıldı`;
}

// Clamped to ≥1: a real reported target always has at least one reporter.
export function bildirilenLabel(distinctReporters: number): string {
	const n = Math.max(1, Math.floor(distinctReporters));
	return `${n} kişi`;
}

export function kefilDurumuLabel(kefil: boolean | null): string | null {
	if (kefil === null) return null;
	return kefil ? "kefilli" : "kefilsiz";
}

export function buAktorLabel(reportedTargets: number | null): string | null {
	if (reportedTargets === null) return null;
	if (reportedTargets <= 1) return "başka raporlu içerik yok";
	return `${reportedTargets} raporlu içerik`;
}
