/**
 * The filing-provenance predicate: was this issue body emitted by `report file`, or typed by a human?
 *
 * The signal is the agent footer, not the author — every report-filed issue shows the same account,
 * so authorship carries no information (ADR 0159).
 *
 * **This file is the group's single definition of that predicate.** `triage kill` re-runs the test
 * itself rather than trusting a caller to have run `triage provenance` first, which makes the guard
 * structural instead of a caller's discipline. When the `triage provenance` verb lands it imports
 * this module too; neither may re-derive the match.
 */

/**
 * Whether a body carries the agent footer, matched **anchored at line-begin**.
 *
 * `renderFooter` (`../report/compose.ts`) emits `` `---\n<sub>` `` then the present fields joined
 * with ` · `, and the literal `Filed by an agent` is always the first of them — so the emitted line
 * begins with `<sub>Filed by an agent` whatever else the footer carries. Three of the five fields
 * are droppable and take their separator with them, so the match may require none of them.
 *
 * **The anchor deliberately diverges from `../report/file-verb.ts`'s bare
 * `body.includes("Filed by an agent")` — do not "fix" the two back into agreement.** That check is
 * correct there: it is a read-back over a body the same process just composed, so nothing else can
 * be in it. Here the body is foreign, and a bare substring fails **open toward `agent`** — an issue
 * that merely quotes the phrase (a bug report about the footer, a pasted body, a discussion of ADR
 * 0159) would answer `agent`, which is the close-eligible direction. Anchoring makes the failure
 * land on `human`, the protected one.
 *
 * An empty body has no footer and so answers `false` ⇒ human, which is the fail-closed default. An
 * *unreadable* body never reaches here: that is a precondition failure the caller seats on `11`,
 * because a verdict manufactured from a failed read is not a measurement.
 */
export const hasAgentFooter = (body: string): boolean =>
	/^<sub>Filed by an agent/m.test(body.replace(/\r\n/g, "\n"));

/** `agent` or `human` — the word the answer channel prints. */
export type Provenance = "agent" | "human";

export const provenanceOf = (body: string): Provenance =>
	hasAgentFooter(body) ? "agent" : "human";
