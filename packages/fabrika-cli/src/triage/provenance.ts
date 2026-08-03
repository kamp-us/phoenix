/**
 * The agent-footer predicate — what `triage provenance` answers with, and the guard `triage kill`
 * re-checks for itself rather than trusting a caller to have run this verb.
 *
 * **The signal is the footer, not the author.** Every report-filed issue shows the same account, so
 * authorship carries no information (ADR 0159).
 *
 * The footer is emitted by `renderFooter` in `../report/compose.ts` as `` `---\n<sub>` `` then the
 * present fields joined with ` · ` then `</sub>`. Only two fields are always there — the literal
 * `Filed by an agent` first and a UTC timestamp last — and a dropped field takes its ` · ` separator
 * with it, so the match binds to the opening of the line and nothing after it.
 */

/**
 * A line **beginning** `<sub>Filed by an agent`.
 *
 * **This deliberately diverges from `../report/file-verb.ts`, which tests the bare substring
 * `Filed by an agent`.** That is correct there: it is a read-back over a body the same process just
 * composed, so nothing else can be in it. Here the body is foreign, and a bare substring fails
 * **open toward `agent`** — an issue that merely quotes the phrase (a bug report about the footer, a
 * pasted body, a discussion of ADR 0159) would answer `agent`, which is the close-eligible
 * direction. Anchoring to the emitted line shape lands that failure on `human`, the protected one.
 * The divergence is deliberate; do not "fix" the two into agreement.
 */
export const AGENT_FOOTER = /^<sub>Filed by an agent/m;

/** Whether `body` carries the agent footer. A body with no footer is `false` — the protected side. */
export const isAgentFiled = (body: string): boolean => AGENT_FOOTER.test(body);
