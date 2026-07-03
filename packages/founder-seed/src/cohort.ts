/**
 * The founding author-mod cohort (#1207) — the founders the seed mints as both
 * `moderator` (role + the `moderates` platform tuple) AND `yazar` (the authorship
 * tier, #1203). This is **data, not logic**: the editable seam {@link seedFounders}
 * reads, so the roster changes here without touching the seed core.
 *
 * Each entry is a founder's `user.id` (the better-auth account id of a real, already
 * registered account) — the seed promotes the matching row and skips an id with no
 * account, so a not-yet-registered or mistyped id is a silent skip, never an orphan
 * grant. An **empty** roster makes the seed a clean no-op (mints nothing).
 *
 * OPSEC — the committed roster is deliberately empty, and that empty state is the
 * permanent, correct one, NOT an un-run bootstrap. Real better-auth account ids are
 * personal identifiers that do not belong in this open-source repo, so they are never
 * committed. The seed HAS been run: the operator fills the real cohort locally at run
 * time (an out-of-band, uncommitted edit) and runs the CLI against the bound D1; the
 * grant lives in the seeded D1 rows, not in a committed roster. So an empty array here
 * is by design — do not read it as "pending", and do not add real ids to source.
 */
export const FOUNDER_COHORT: ReadonlyArray<string> = [
	// "<founder user.id>",
];
