/**
 * The shared contributions copy for the two profile surfaces (#2203). Both `/u/`
 * (public) and `/profile` (self) render the same `EmptyState` card and the same
 * `ContributionRow` cards; the only intentional divergence is the section heading,
 * which stays per-surface-intent: third-person `katkılar` on someone else's public
 * profile, second-person `katkıların` on the owner's own self-service view. Naming
 * them here makes the split intentional rather than the accidental drift #2203
 * observed. Lowercase Turkish (user-facing copy).
 */

export const CONTRIBUTIONS_HEADING = {
	/** `/u/:username` — a third party viewing someone's public contributions. */
	public: "katkılar",
	/** `/profile` — the owner viewing their own contributions. */
	self: "katkıların",
} as const;

/** The one empty-state card both surfaces render (via the shared `EmptyState`). */
export const CONTRIBUTIONS_EMPTY = {
	title: "henüz katkı yok.",
	description: "ilk tanımını ya da başlığını ekleyince burada görünür.",
} as const;
