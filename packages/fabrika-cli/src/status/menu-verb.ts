/**
 * `status menu` — the landed skill roster, derived from the installed plugin's skills tree.
 *
 * **The roster is derived, never stored.** No committed menu file and no generate step: the
 * directory is the list, the same on-demand idiom ADR 0129 applies to the repo's decision records. A
 * committed roster is a copy, and a copy rots.
 *
 * **The header has two states, not three.** `unknown` is a *composite* rendering — this verb refuses
 * instead, because a caller invoking `menu` directly reads the exit status.
 */
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {type AsOf, asOfToken, description, row} from "./fields.ts";
import type {RosterRead} from "./roster.ts";

const VERB = "status menu";

export type MenuState = "ready" | "empty";

export interface MenuInput {
	readonly roster: RosterRead;
	readonly asOf: AsOf;
	readonly json: boolean;
}

export const menuState = (skillCount: number): MenuState => (skillCount === 0 ? "empty" : "ready");

/** A roster read that did not resolve — the only two shapes that owe a refusal. */
export type RosterUnresolved = Exclude<RosterRead, {readonly _tag: "Resolved"}>;

/**
 * The refusal an unresolved roster owes.
 *
 * Shared with `status config`, which seats the identical pair on the identical two codes: `7` is a
 * fact about a caller-supplied path, `11` is a failed read, and folding them is the defect this
 * group exists to prevent.
 */
export const rosterRefusal = (verb: string, roster: RosterUnresolved): VerbOutcome =>
	roster._tag === "AbsentExplicit"
		? refuse(
				ZERO_SCOPE,
				`${verb}: --skills-dir ${roster.display} is proven absent — refusing to answer (ADR 0092).`,
			)
		: refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read ${roster.display}: ${roster.reason} — the roster is UNKNOWN, never empty.`,
			);

export const runMenu = ({roster, asOf, json}: MenuInput): VerbOutcome => {
	if (roster._tag !== "Resolved") return rosterRefusal(VERB, roster);

	const state = menuState(roster.skills.length);
	const notice = `${VERB}: roster ${roster.display} (${roster.tier}), ${roster.skills.length} skills, ${roster.unreadableFrontmatter} unreadable frontmatter.`;
	const rows = roster.skills.map((skill) => ({
		name: skill.name,
		invocation: skill.invocation,
		invocationAxis: skill.invocationAxis,
		description: description(skill.description),
	}));

	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: state,
				count: rows.length,
				asOf: asOf.at,
				asOfKind: asOf.kind,
				skills: rows,
			})}\n`,
			[notice],
		);
	}
	const lines = [
		row("menu", state, String(rows.length), asOfToken(asOf)),
		...rows.map((r) => row("skill", r.name, r.invocation, r.invocationAxis, r.description)),
	];
	return answer(`${lines.join("\n")}\n`, [notice]);
};
