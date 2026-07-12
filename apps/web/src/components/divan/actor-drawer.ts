/**
 * The künye actor-drawer's render + interaction decisions (#1852, ADR 0138) — the
 * epic-#1665 keystone, factored DOM-free in the `triage-loop.ts` / `raporlarGating.ts`
 * idiom so the drawer's field copy, the two chamber modes, the cross-mode hop mapping,
 * and the "mod record informs but never verdicts" guard are unit-testable without a
 * React runtime (`apps/web/src` has no jsdom).
 *
 * The drawer is the divan's actor-centric spine (ADR 0138): the actor is the JOIN key
 * across the two divan modes. `raporlar` (moderation) and `kefil` (vouch) are two
 * entries into the SAME drawer, opened on the focused item's author. It renders the
 * actor's künye — tier, karma, üretim counts (tanım/gönderi/yorum), the two trust tells
 * (`kaldırılan` = prior removals, `bildirilen` = times reported), `kefil durumu`, and
 * the "bu aktör" other-reported-target count — all already carried on the gated
 * `report.listOpen` row (a MODE over the same read, never a re-fetch).
 *
 * The seam the downstream slices consume is deliberately exposed here: `distinctReporters`
 * (the #1855 remove-the-wave numerator) and `reportedTargets` (#1855's "bu aktör" entry
 * point) ride the same actor projection the drawer renders.
 */

/** The two chambers the drawer is an entry into (ADR 0138): moderation and vouch. */
export type Chamber = "raporlar" | "kefil";

/** The keys the actor-drawer binds on top of the triage loop (ADR 0138). */
export type DrawerAction =
	| {readonly kind: "toggleDrawer"}
	| {readonly kind: "hopKefil"}
	| {readonly kind: "hopModeration"};

/**
 * Map a raw key to a drawer action, or `null` for a key the drawer doesn't own (the
 * loop's own bindings then handle it). `A` toggles the drawer, `V` hops to the actor's
 * kefil rite, `M` hops to their moderation record — the founder-confirmed uppercase
 * bindings, so a lowercase key mid-typing is never a hop.
 */
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

/**
 * The chamber a hop lands in (ADR 0138 — the spine made navigable): `V` from any
 * chamber reaches the actor's kefil rite; `M` reaches their moderation record. The hop
 * is absolute (it targets a chamber, not a toggle) so the same key always lands the
 * same place regardless of where the moderator hopped from.
 */
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

/**
 * The drawer's default open state per surface (ADR 0138 — desktop-first founder call):
 * docked open on desktop, closed on a narrow surface where a docked panel would crowd
 * the single-item loop. `A` toggles from whichever default the surface starts at.
 */
export function drawerDefaultOpen(isDesktop: boolean): boolean {
	return isDesktop;
}

/**
 * Whether the mod record may drive a verdict in this chamber (ADR 0138 §3, the
 * agents-deploy/humans-release boundary). In `raporlar` the record IS the thing being
 * judged; in `kefil` the record is VISIBLE evidence for a human vouching a person and
 * MUST NOT auto-decide the rite — always `false` for `kefil`. The record is shown in
 * both chambers; this guard is what keeps showing it in kefil mode from ever verdicting.
 */
export function modRecordVerdicts(chamber: Chamber): boolean {
	return chamber === "raporlar";
}

/** The actor's standing + footprint the drawer renders — the projection off the gated row. */
export interface ActorStanding {
	readonly tier: string | null;
	readonly karma: number | null;
	/** `kaldırılan` — how many of the actor's targets a moderator previously removed. */
	readonly priorRemovals: number | null;
	/** `bildirilen` — how many distinct reporters filed against the focused target. */
	readonly distinctReporters: number;
	readonly definitionCount: number | null;
	readonly postCount: number | null;
	readonly commentCount: number | null;
	readonly kefil: boolean | null;
	/** The "bu aktör" count — how many of the actor's targets are open-reported. */
	readonly reportedTargets: number | null;
}

/**
 * The actor's identity line (ADR 0138): `@handle · tier · N karma`, dropping any clause
 * that can't be resolved. `null` when neither a handle nor a tier resolves (an
 * anonymized / hidden actor) so the drawer renders no fabricated identity.
 */
export function actorIdentityLabel(handle: string | null, standing: ActorStanding): string | null {
	const parts: string[] = [];
	const h = handle?.trim();
	if (h) parts.push(`@${h}`);
	if (standing.tier) parts.push(standing.tier);
	if (standing.karma !== null) parts.push(`${standing.karma} karma`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The üretim (production) footprint line (ADR 0138): `N tanım · N gönderi · N yorum`,
 * the actor's live content record. `null` when the counts are unresolved (an
 * unresolvable actor), so the drawer shows no fabricated footprint. Zero counts render
 * faithfully (`0 tanım · 0 gönderi · 0 yorum` — a real newcomer, not absence).
 */
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

/**
 * The `sicil` trust tell (ADR 0138): `N kaldırıldı` when the actor has prior removals,
 * else the clean `temiz` — read under the `sicil` key, so the value no longer re-states
 * the noun (the old `temiz sicil` doubled it). `null` when unresolved — the drawer then
 * renders no removal line rather than a false "temiz".
 */
export function kaldirilanLabel(priorRemovals: number | null): string | null {
	if (priorRemovals === null) return null;
	if (priorRemovals <= 0) return "temiz";
	return `${priorRemovals} kaldırıldı`;
}

/**
 * The `bildiren` trust tell (ADR 0138): `N kişi` — how many distinct reporters stand
 * behind the focused report, the pile-on's real breadth. Read under the `bildiren` key,
 * so the value is the bare count (the old `N kişi bildirdi` re-stated the verb). Clamped
 * to ≥1 for a real reported target; the diversity numerator #1855's wave slice also reads.
 */
export function bildirilenLabel(distinctReporters: number): string {
	const n = Math.max(1, Math.floor(distinctReporters));
	return `${n} kişi`;
}

/**
 * The `kefil durumu` line (ADR 0138): `kefilli` when the actor is actively vouched,
 * `kefilsiz` when not — the vouch tell the moderation chamber reads and the kefil
 * chamber acts on. `null` when unresolved, so no false status shows.
 */
export function kefilDurumuLabel(kefil: boolean | null): string | null {
	if (kefil === null) return null;
	return kefil ? "kefilli" : "kefilsiz";
}

/**
 * The "bu aktör" line (ADR 0138): `N raporlu içerik` — the entry point #1855's
 * remove-the-wave grows from (actor-grouped selection). Read under the `bu aktör` key,
 * so the value no longer re-states "bu aktörün" (the old line doubled it). `null` when
 * unresolved. Zero/one renders the clean `başka raporlu içerik yok`.
 */
export function buAktorLabel(reportedTargets: number | null): string | null {
	if (reportedTargets === null) return null;
	if (reportedTargets <= 1) return "başka raporlu içerik yok";
	return `${reportedTargets} raporlu içerik`;
}
