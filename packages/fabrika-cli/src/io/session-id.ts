/**
 * The one session-attribution read — every verb's identity comes through here or nowhere.
 *
 * The precedence chain is `FABRIKA_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` →
 * `PI_SUBAGENT_PARENT_SESSION`, and an environment carrying none of the three is refused by the
 * caller (#6960). Before this module every site hardcoded `CLAUDE_CODE_SESSION_ID`, so under pi —
 * the repo's sole harness — every attribution-bearing verb failed on first contact.
 *
 * The documented invariants are preserved structurally, not enforced here: the value is whatever the
 * harness stamped — stable within a session (#5028) — and the CLI never mints or generates an
 * identity when the chain comes up empty (ADR 0215 §5 rejects lease/TTL/steal; #4500's
 * namespace-collapse reasoning). Call sites that name a directory with the id keep their own
 * single-path-segment check (`triage scratch`, `build scratch`).
 */

/**
 * The consulted variables, in precedence order — the unset refusal names all three.
 *
 * opencode exposes no session id a driver shell could read (verified against upstream `sst/opencode`
 * at v1.18.21: the bash tool spawns with inherited environment only, and no `OPENCODE_SESSION_ID`
 * exists anywhere in the shipped binary), so an opencode driver must export `FABRIKA_SESSION_ID` by
 * hand before any attribution-bearing verb — otherwise every verb refuses with
 * {@link sessionIdUnset}.
 */
export const SESSION_ID_VARS = [
	"FABRIKA_SESSION_ID",
	"CLAUDE_CODE_SESSION_ID",
	"PI_SUBAGENT_PARENT_SESSION",
] as const;

/** What a caller passes as the environment half of the read. */
export type SessionEnv = Readonly<Record<string, string | undefined>>;

/**
 * The session id this run is stamped with, or `null` when none of {@link SESSION_ID_VARS} carries a
 * non-blank value. First set variable wins; a blank value counts as unset and falls through.
 */
export const sessionIdFrom = (env: SessionEnv): string | null => {
	for (const name of SESSION_ID_VARS) {
		const raw = (env[name] ?? "").trim();
		if (raw !== "") return raw;
	}
	return null;
};

/** The refusal clause naming every consulted variable, so no caller's message drifts from another's. */
export const sessionIdUnset = `no session id is set — ${SESSION_ID_VARS.join(", ")} are all unset`;
