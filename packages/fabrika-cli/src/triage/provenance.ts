/**
 * The filing-provenance predicate: was this issue reported by an agent, or typed by a human?
 *
 * **Two agent signals, not one.** ADR 0159 made the report footer the signal because every filing
 * showed the same shared account, so authorship carried no information. The founder's 2026-08-09
 * ruling on #4619 narrows that: a filing authored by an account in the **configured operator set** is
 * agent-reported whether or not the footer is present, because footer-absence there is the emitter
 * gap #4619 tracks rather than evidence of a human author. Footer-absence from any *other* author is
 * still human-owned, exactly as ADR 0159 says.
 *
 * **This file is the group's single definition of that predicate.** `triage kill` re-runs the test
 * itself rather than trusting a caller to have run `triage provenance` first, which makes the guard
 * structural instead of a caller's discipline; the `triage provenance` verb imports it too. Neither
 * may re-derive the footer match or the operator-membership test.
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
 * An empty body has no footer, so it answers `false`. An *unreadable* body never reaches here: that
 * is a precondition failure the caller seats on `11`, because a verdict manufactured from a failed
 * read is not a measurement.
 */
export const hasAgentFooter = (body: string): boolean =>
	/^<sub>Filed by an agent/m.test(body.replace(/\r\n/g, "\n"));

/**
 * The environment key naming the operator accounts, comma- or whitespace-separated.
 *
 * The set is an **input resolved from configuration**, never a login list in committed source: a
 * hardcoded handle is an operator identity leaking into a shared artifact (#2393), and a set that
 * grows by editing a released package is a set nobody can widen. A leading `@` is tolerated so a
 * value pasted from a GitHub mention still resolves.
 */
export const OPERATOR_ACCOUNTS_ENV = "FABRIKA_OPERATOR_ACCOUNTS";

/**
 * The configured operator accounts, lowercased for the case-insensitive comparison GitHub logins
 * take. Unset or blank yields the **empty** set, which reduces the predicate to ADR 0159's
 * footer-only rule — no filing becomes newly close-eligible because the config was missing.
 */
export const resolveOperatorAccounts = (
	env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> =>
	new Set(
		(env[OPERATOR_ACCOUNTS_ENV] ?? "")
			.split(/[,\s]+/)
			.map((name) => name.trim().replace(/^@/, "").toLowerCase())
			.filter((name) => name !== ""),
	);

/** Whether `author` is one of the configured operator accounts. An empty login never is. */
export const isOperatorAccount = (author: string, operators: ReadonlySet<string>): boolean => {
	const login = author.trim().replace(/^@/, "").toLowerCase();
	return login !== "" && operators.has(login);
};

/** `agent` or `human` — the word the answer channel prints. */
export type Provenance = "agent" | "human";

/** The two fields the predicate reads. A caller that has only a body has not read the filing. */
export interface Filing {
	readonly body: string;
	readonly author: string;
}

export const provenanceOf = (filing: Filing, operators: ReadonlySet<string>): Provenance =>
	hasAgentFooter(filing.body) || isOperatorAccount(filing.author, operators) ? "agent" : "human";
