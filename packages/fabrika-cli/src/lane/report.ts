/**
 * The terminal-token map — one shell terminal in, one operator event out, in code (#5736).
 *
 * Each fabrika shell ends on a fixed token from a closed vocabulary its own skill owns; this table
 * is the one place those vocabularies meet the machine's six events, replacing the prose
 * translation table the operator LLM used to execute per spawn. The map is total over the tokens
 * listed and refuses everything else — an unrecognised token is a refusal, never a permissive
 * `BLOCKED` guess, because "a report you cannot parse" stops being a failure class only when
 * nothing is left to parse.
 */
import type {OperatorEvent} from "./machine.ts";

/**
 * Every recognised terminal token, grouped by the shell skill that owns its vocabulary — the
 * builder's (`build/SKILL.md`), the reviewer's (`review/SKILL.md`), the shipper's
 * (`ship/SKILL.md`). Documentation and test surface; the lookup below flattens it.
 */
export const SHELL_VOCABULARIES = {
	builder: {
		"SHIPPED-PR": "DONE",
		"SUCCESS-NO-PR": "DONE",
		"BACKED-OFF": "BLOCKED",
		ESCALATED: "BLOCKED",
		STOPPED: "BLOCKED",
	},
	reviewer: {
		PASS: "PASS",
		FAIL: "FAIL",
		UNKNOWN: "BLOCKED",
		STALE: "BLOCKED",
		UNBINDABLE: "BLOCKED",
		ROUTED: "BLOCKED",
	},
	shipper: {
		"ALREADY-MERGED": "DONE",
		QUEUED: "DONE",
		LANDED: "DONE",
		REFUSED: "BLOCKED",
		"AWAITING-CP-APPROVAL": "BLOCKED",
		ROUTED: "BLOCKED",
		UNRESOLVED: "BLOCKED",
		// An ejection is always "routed to repair", so it feeds the machine's `ship` FAIL edge and
		// spends a retry rather than parking the lane (#5807).
		EJECTED: "FAIL",
		UNKNOWN: "BLOCKED",
	},
} as const satisfies Readonly<Record<string, Readonly<Record<string, OperatorEvent>>>>;

const TOKEN_EVENTS: Readonly<Record<string, OperatorEvent>> = Object.assign(
	{},
	...Object.values(SHELL_VOCABULARIES),
);

/** The recognised tokens, for the refusal message — sorted so the listing is deterministic. */
export const KNOWN_TOKENS: ReadonlyArray<string> = Object.keys(TOKEN_EVENTS).sort();

export type TokenResolution =
	| {readonly _tag: "Mapped"; readonly token: string; readonly event: OperatorEvent}
	| {readonly _tag: "Unrecognised"; readonly reason: string};

/**
 * Resolve one shell terminal token to its operator event. Case-insensitive, because the shipper's
 * vocabulary is spelled lower-case in its skill (`already-merged`, `landed`) and the builder's
 * upper-case — the token, not its casing, is the report.
 */
export const eventForToken = (raw: string): TokenResolution => {
	const token = raw.trim().toUpperCase();
	const event = TOKEN_EVENTS[token];
	return event === undefined
		? {
				_tag: "Unrecognised",
				reason: `"${raw}" is no shell's terminal token (known: ${KNOWN_TOKENS.join(", ")})`,
			}
		: {_tag: "Mapped", token, event};
};
