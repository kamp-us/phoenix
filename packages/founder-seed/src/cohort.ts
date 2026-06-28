/**
 * The founding author-mod cohort (#1207) — the ~20 founders the seed mints as both
 * `moderator` (role + the `moderates` platform tuple) AND `yazar` (the authorship
 * tier, #1203). This is **data, not logic**: the editable seam {@link seedFounders}
 * reads, so the roster changes here without touching the seed core.
 *
 * Each entry is a founder's `user.id` (the better-auth account id of a real, already
 * registered account) — the seed promotes the matching row and skips an id with no
 * account, so a not-yet-registered or mistyped id is a silent skip, never an orphan
 * grant. An **empty** roster makes the seed a clean no-op (mints nothing).
 *
 * FILL-LATER: the ~20 founder ids are added here when the cohort is named — one
 * `user.id` string per line. Do NOT invent identities; only real registered account
 * ids belong here. Until then the roster is empty and the seed no-ops.
 */
export const FOUNDER_COHORT: ReadonlyArray<string> = [
	// "<founder user.id>",
];
