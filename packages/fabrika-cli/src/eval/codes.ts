/**
 * The one exit table every `eval` verb allocates from, so a code means one thing across the group.
 *
 * Before this table the group seated *every* refusal on `1` — a decoded-and-invalid manifest and a
 * manifest that could not be read exited alike, so a caller reading `$?` could not tell a verdict
 * the verb PROVED from a failure to invoke it (`../verb.ts`, #4208/#4219). What stays on `1` is
 * exactly what the convention reserves it for: a usage error (a flag naming something that is not a
 * stage, a surface, or an arm) and a read that failed before the verb could judge anything.
 *
 * The two shared seats are **imported from the base, never re-typed** — the discipline
 * `../review-ui/codes.ts` states, and the reason `../exit-code-alignment.ts` can check them. `12`
 * and up are this group's own.
 *
 * `0`, `1` and `127` are reserved by the interface convention (`../verb.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	NO_TARGET as REPORT_NO_TARGET,
} from "../report/codes.ts";

/**
 * A named artifact was read in full and does not conform: a corpus manifest, a runner-rows file, a
 * `/skill-creator` eval set, a ruled-KEEP enumeration, or a provenance ledger.
 *
 * The base's section seat, widened to whole documents the same way `../review-ui/codes.ts` widens
 * it. Deliberately not `1`: the bytes were in hand and the schema answered, so this is a fact about
 * the artifact. A read that never produced bytes is the `1` above.
 */
export const MALFORMED_DOCUMENT = REPORT_BAD_SECTIONS;

/**
 * Zero scope, proven: the artifact decodes and carries no eval cases (ADR 0092).
 *
 * A suite that ran nothing and exited 0 is the vacuous pass the ADR forbids, so the emptiness is an
 * outcome with its own seat rather than a green with a caveat on stderr.
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;

/**
 * Proven: the ruled-KEEP enumeration decodes but breaks its own integrity rules.
 *
 * Its own seat rather than {@link MALFORMED_DOCUMENT} because the caller's remedy differs — the
 * schema is satisfied, so no decoder change can help; a human has to reconcile the membership list.
 */
export const INTEGRITY_VIOLATION = 12;

/**
 * Proven: the suite completed and at least one planned run did not execute.
 *
 * Not a failed invocation — the runner ran, the ledger is on stdout, and this reports only that the
 * evidence is incomplete. Whether the executed runs *passed* is the oracle's answer downstream, and
 * never this code.
 */
export const RUNS_NOT_EXECUTED = 13;
