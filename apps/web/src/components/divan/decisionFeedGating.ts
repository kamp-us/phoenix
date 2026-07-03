/**
 * The decision-feed's render decisions (#1704, the two-person team-ledger), factored
 * DOM-free in the `raporlarGating.ts` idiom so each gate is unit-testable without a
 * React runtime. The feed is a moderator-only view inside `/divan`, dark behind the
 * same `phoenix-mod-queue` flag as the queue (`report.listResolved` is `Moderate`-gated
 * server-side, so a forced non-mod read denies the invisible `UNAUTHORIZED`).
 *
 * The feed makes moderation legible BETWEEN two humans: who decided what, when — so the
 * decision and the resolver are first-class copy, never a footnote. A `removed` decision
 * carries the `Geri getir` (restore) disagreement affordance; a `dismissed` one is
 * terminal (nothing to bring back).
 */
import type {Resolution} from "../../../worker/features/report/resolution";

/**
 * The decision cell's lowercase-Turkish copy: `removed` → "kaldırıldı" (content taken
 * down), `dismissed` → "yoksayıldı" (report found unfounded). A closed set, so the
 * switch is exhaustive.
 */
export function decisionLabel(resolution: Resolution): string {
	switch (resolution) {
		case "removed":
			return "kaldırıldı";
		case "dismissed":
			return "yoksayıldı";
	}
}

/**
 * The resolver byline — first-class, so the two-person ledger reads "who decided". The
 * server-resolved handle as `@handle` when present; a generic "moderatör" when the
 * identity couldn't be resolved (never the raw account id — a UUID isn't legible copy).
 */
export function resolverLabel(handle: string | null): string {
	const trimmed = handle?.trim();
	return trimmed ? `@${trimmed}` : "moderatör";
}

/**
 * Only a `removed` decision is restorable — restore brings content back live and
 * reopens its reports (`report.restore`). A `dismissed` decision took no action, so
 * there is nothing to bring back and the affordance is absent.
 */
export function isRestorable(resolution: Resolution): boolean {
	return resolution === "removed";
}
