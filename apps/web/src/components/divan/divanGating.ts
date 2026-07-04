/**
 * The divan surface's render decisions, factored DOM-free so each gate is
 * unit-testable without a DOM/React runtime — the pure-extraction idiom of
 * `flagGateChild` / `shouldShowOnramp` (`apps/web/src` has no jsdom). The divan
 * (#1290, epic #1202) is the yazar/mod proving ground, shipped dark behind the
 * `phoenix-authorship-loop` flag (#1204).
 *
 * The role model the gates encode (mirroring the backend `requireDivanAccess`
 * disjunction, divan/gate.ts): the divan is reached by yazar OR mod. The frontend's
 * trusted signals are the flag value and `useMe().me` — both `tier` and the
 * server-authoritative `isModerator` (#1320, read off the `moderates` relation
 * tuple) — plus the server's own access verdict (the gated `divan.roster` read
 * either resolves or denies with the invisible `UNAUTHORIZED`). So:
 *
 *   - **Access** (topbar entry + page) is server-authoritative: the
 *     `useDivanAccess` probe asks the gated read whether THIS user stands, which
 *     answers the yazar-OR-mod question without a client authority guess.
 *   - **vouch** ("kefil ol") is the yazar power (`requireVouch` = yazar floor), so
 *     it gates on the trusted `tier === "yazar"`.
 *   - **promote** ("yazar yap") is the mod power (`user.promote` is `Moderate`-gated),
 *     so it gates on the trusted `isModerator` signal — NOT on `tier`. Keying off
 *     `tier` ("non-yazar present must be a mod") wrongly hid promote from a dual-role
 *     yazar+moderator, who reads `tier: "yazar"` (#1320, #1207's founding cohort);
 *     `isModerator` shows it to the actual moderator regardless of tier. The server
 *     remains the sole authority (the shipped `PromotionActions` convention, #1206):
 *     an unauthorized call comes back the invisible denial.
 */
import {TARGET_KINDS, type TargetKind} from "../../../worker/db/target-kind";
import type {Tier} from "../../../worker/features/kunye/standing";
import {actorLabel} from "../moderation/actor-identity";

/**
 * Show the `/divan` page content iff the authorship-loop flag is on. Off (and
 * every flag failure mode — loading/error/undeclared all resolve to `false`
 * upstream) renders the 404, so with the flag off the route is effectively absent.
 */
export function shouldRenderDivanPage(flagOn: boolean): boolean {
	return flagOn;
}

/**
 * Show the topbar `/divan` entry iff the flag is on AND the server granted divan
 * access (the yazar-OR-mod probe). A çaylak/visitor's probe denies (`accessGranted`
 * false), and a flag-off render never probes — both yield `false`, so the entry is
 * invisible to everyone but a yazar/mod with the loop on.
 */
export function shouldShowDivanEntry(flagOn: boolean, accessGranted: boolean): boolean {
	return flagOn && accessGranted;
}

/**
 * Show the yazar **"kefil ol"** (vouch) affordance iff the viewer is a yazar — the
 * trusted account tier (`requireVouch` is the yazar floor server-side). A mod who
 * is not a yazar cannot vouch, so the affordance is yazar-tier only.
 */
export function vouchVisible(tier: Tier | undefined): boolean {
	return tier === "yazar";
}

/**
 * Enable the vouch action iff the viewer is a yazar AND has opened the çaylak
 * detail. Staking on a çaylak you have not reviewed is unrepresentable — the
 * detail-open precondition (#1290 AC) is carried as `detailOpened`.
 */
export function canVouch(tier: Tier | undefined, detailOpened: boolean): boolean {
	return vouchVisible(tier) && detailOpened;
}

/**
 * Show the mod **"yazar yap"** (promote) affordance iff the viewer is a platform
 * moderator (the trusted server-authoritative `isModerator` signal, #1320). Keyed
 * off `isModerator` — never `tier` — so a dual-role yazar+moderator (who reads
 * `tier: "yazar"`, #1207's founding cohort) still sees promote, while a yazar-only
 * viewer does not. `false`/not-yet-loaded `me` resolves to hidden.
 */
export function promoteVisible(isModerator: boolean): boolean {
	return isModerator;
}

/**
 * The display handle for a çaylak in the divan: their display name, else their
 * `@username`, else the lowercase-Turkish "çaylak" fallback (an anonymized /
 * not-yet-named row). Never the raw user id — the divan reads a person, not an id.
 * The çaylak-specific fallback over the shared actor-row rule (ADR 0145): one tested
 * handle resolver across every mod/admin surface, divan supplying its own noun.
 */
export function caylakLabel(displayName: string | null, username: string | null): string {
	return actorLabel(displayName, username, "çaylak");
}

/**
 * Split a backlog item's `<kind>:<itemId>` composite id (the identity
 * `DivanBacklogItemView` emits, the same `divan.vote` takes) back into its report
 * target, or `null` if malformed / unknown-kind — so a `bildir` on a divan item
 * names the underlying definition/post/comment to `report.submit`.
 */
export function parseBacklogItemId(
	id: string,
): {readonly targetKind: TargetKind; readonly targetId: string} | null {
	const sep = id.indexOf(":");
	if (sep <= 0 || sep === id.length - 1) return null;
	const kind = id.slice(0, sep);
	if (!(TARGET_KINDS as ReadonlyArray<string>).includes(kind)) return null;
	return {targetKind: kind as TargetKind, targetId: id.slice(sep + 1)};
}

/** The lowercase-Turkish per-kind noun for a sandboxed backlog item. */
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

/** The promote-call outcome the detail's status line renders (words, never color). */
export type PromoteOutcome = "promoted" | "alreadyYazar" | "denied" | "error";

/** Map a `user.promote` `{promoted}` receipt + denial/failure onto its outcome. */
export function promoteOutcome(
	promoted: boolean | undefined,
	denied: boolean,
	failed: boolean,
): PromoteOutcome {
	if (denied) return "denied";
	if (failed) return "error";
	return promoted ? "promoted" : "alreadyYazar";
}

/** The lowercase-Turkish status line for a promote outcome. */
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

/** The vouch-call outcome the stake-confirm sheet's status line renders. */
export type VouchOutcome = "promoted" | "recorded" | "limit" | "denied" | "error";

/** Map a `user.vouch` `{promoted}` receipt + denial code onto its outcome. */
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

/** The lowercase-Turkish status line for a vouch outcome. */
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
