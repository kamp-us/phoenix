/**
 * The single stamped-claim-marker producer — every claim writer composes its body here (#3987).
 *
 * `claim-resolution.ts` owns the marker grammar and `claim-presence.ts` the stamp's shape, but
 * the *composition* of the two — read this run's session presence, append it when it resolved,
 * omit it when it did not — was re-derived per writer, so exactly one writer stamped and the
 * others posted unstampable markers. An unstamped marker reads indeterminate, and indeterminate
 * counts as a live owner, so dead-claimant supersession (ADR 0191 liveness, #3751) was inert on
 * every lane those writers claimed. Routing all of them through one producer is what makes
 * liveness evaluable regardless of which path wrote the claim; the fail-closed direction is
 * untouched — an unstamped legacy marker still stands.
 *
 * `presence` is a parameter with a live default rather than an internal read, so the OS boundary
 * (`presence-io.ts`) is injectable at a writer's edge: that is what lets each writer's own test
 * prove it stamps, on a machine (CI) where no session process resolves.
 *
 * Stamping makes liveness *evaluable*, not universal: the probe is local, so a marker stamped on
 * another machine stays indeterminate and its claim stands. The host-independent signal that would
 * close that — the crew tracker's presence keyspace (#3938 / epic #3766) — left with ADR 0279, so
 * the multi-host case has no planned home; either way it is out of scope here. See
 * gh-issue-intake-formats.md §7 "Liveness is same-host by construction".
 */
import {type ClaimPresence, formatClaimPresence} from "./claim-presence.ts";
import {claimCommentBody} from "./claim-resolution.ts";
import {currentSessionPresence} from "./presence-io.ts";

export const stampedClaimBody = (
	session: string,
	at: string,
	presence: ClaimPresence | null = currentSessionPresence(),
): string =>
	claimCommentBody(session, at, presence === null ? null : formatClaimPresence(presence));
