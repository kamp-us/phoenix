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
import {SHIP_CLASS_NAMES} from "../review/classes.ts";
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
		// An epic child builds, commits and deliberately opens no PR (ADR 0285), so neither of the
		// two terminals above fits and the token used to fall to the refusal — recording a clean
		// build as BLOCKED (#6019). Its proof is already the child arm of `lane prove`: a DONE out
		// of `build` in a child role stands on the range's commits, not on a PR.
		"BUILT-NO-PR": "DONE",
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
		// The two queue terminals are waits, not landings (ADR 0313). Only a merge this pipeline read
		// back is `DONE`, and neither of these is one: `QUEUED` means the arm took and the shipper did
		// not watch it to an outcome, `UNRESOLVED` means it watched to its horizon and the PR is still
		// in the queue. Both used to fold the lane out of the loop — `QUEUED` to `shipped` over a merge
		// nobody observed, `UNRESOLVED` to a human park over a merge that was always going to land
		// (#6178, #6462) — and both now route to the machine's wait cell, which a driver re-folds.
		QUEUED: "WIP",
		UNRESOLVED: "WIP",
		LANDED: "DONE",
		REFUSED: "BLOCKED",
		"AWAITING-CP-APPROVAL": "BLOCKED",
		// A routing terminal names its arm, because the three arms are three different answers to
		// the machine: repair is work this lane can retry, heal-ci and review are waits it cannot
		// (#6002). A shipper that routed to repair and reported one flat `ROUTED` parked the lane
		// on a control-plane approval nobody was waiting on.
		"ROUTED-REPAIR": "FAIL",
		"ROUTED-HEAL-CI": "BLOCKED",
		"ROUTED-REVIEW": "BLOCKED",
		// An ejection is always "routed to repair", so it feeds the machine's `ship` FAIL edge and
		// spends a retry rather than parking the lane (#5807).
		EJECTED: "FAIL",
		UNKNOWN: "BLOCKED",
	},
} as const satisfies Readonly<Record<string, Readonly<Record<string, OperatorEvent>>>>;

export type Flattening =
	| {readonly _tag: "Flat"; readonly tokens: Readonly<Record<string, OperatorEvent>>}
	| {readonly _tag: "Collision"; readonly collisions: ReadonlyArray<string>};

/**
 * Flatten the per-shell vocabularies into the one map `lane report` looks a bare token up in, and
 * name every disagreement rather than resolve it.
 *
 * `lane report` takes no shell argument — a token is all a shell hands over — so the lookup has to
 * be flat, and two shells may legitimately share a spelling: `UNKNOWN` is both the reviewer's and
 * the shipper's, and means `BLOCKED` in both. What must never happen is two shells spelling one
 * token with *different* events. A plain spread resolves that to whichever group is written last,
 * silently rewriting the loser's event; here it is a `Collision` the caller cannot read past.
 */
export const flattenVocabularies = (
	vocabularies: Readonly<Record<string, Readonly<Record<string, OperatorEvent>>>>,
): Flattening => {
	const tokens: Record<string, OperatorEvent> = {};
	const owners: Record<string, string> = {};
	const collisions: string[] = [];
	for (const [shell, vocabulary] of Object.entries(vocabularies)) {
		for (const [token, event] of Object.entries(vocabulary)) {
			const seen = tokens[token];
			if (seen !== undefined && seen !== event) {
				collisions.push(`${token}: ${owners[token]} reports ${seen}, ${shell} reports ${event}`);
				continue;
			}
			tokens[token] = event;
			owners[token] = shell;
		}
	}
	return collisions.length === 0
		? {_tag: "Flat", tokens}
		: {_tag: "Collision", collisions: collisions.sort()};
};

const flattened = flattenVocabularies(SHELL_VOCABULARIES);
if (flattened._tag === "Collision") {
	throw new Error(
		`lane report: the shell vocabularies disagree on ${flattened.collisions.length} token(s) — ${flattened.collisions.join("; ")}. Give the arms distinct spellings; one flat lookup cannot hold both.`,
	);
}

const TOKEN_EVENTS: Readonly<Record<string, OperatorEvent>> = flattened.tokens;

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

/**
 * Why a lane parked, as a closed set of tokens — the field that makes a `BLOCKED` clearable (#6480).
 *
 * The token map above folds thirteen distinct shell terminals into one flat `BLOCKED`, so the event
 * that lands records that a park happened and never why. `recipe unpark` keys its recipe table on a
 * park's cause, which left every `BLOCKED` novel by construction: the mechanism to clear a park
 * autonomously existed and could match nothing. A cause is the key it was missing.
 *
 * It is a closed set for the same reason the terminal tokens are: a free-text cause is prose a
 * recipe would have to interpret, and interpreting a report is the failure class this module
 * deletes. Each entry's value is what the cause means, in the clause a refusal can quote — a new
 * cause is a row here plus a `KNOWN_PARKS` row that says how to prove it gone, never one alone.
 */
export const PARK_CAUSES = {
	/**
	 * The #6395 shape: a finished lane's worktree still holds the branch this lane must build on, so
	 * `build branch --resume-lane` refuses at exit 11 rather than re-key a branch out from under
	 * another tree. The whole remedy is removing that worktree, which is why it owes no decision.
	 */
	"worktree-holds-branch": "a working tree still holds the lane branch this build must stand on",
} as const;

export type ParkCause = keyof typeof PARK_CAUSES;

/** The recognised causes, for a refusal's listing — sorted so the listing is deterministic. */
export const PARK_CAUSE_TOKENS: ReadonlyArray<string> = Object.keys(PARK_CAUSES).sort();

export type ClassResolution =
	| {readonly _tag: "Classed"; readonly classes: ReadonlyArray<string> | null}
	| {readonly _tag: "Rejected"; readonly reason: string};

/**
 * Resolve the `--class` values against the closed set `ship scope` / `review scope` derive from.
 *
 * A silent miss is the failure mode this closes: an unknown spelling matched no `class:<name>` arm,
 * the guarded array fell through to its unclassed target, and the lane built as a plain lane with
 * the rendered-visual verdict it owed never asked for (ADR 0317). Spelling is normalised the way a
 * cause's is, so `--class UI` is the `ui` class rather than a refusal.
 */
export const classesForEvent = (raw: ReadonlyArray<string>): ClassResolution => {
	if (raw.length === 0) return {_tag: "Classed", classes: null};
	const classes: string[] = [];
	for (const value of raw) {
		const token = value.trim().toLowerCase();
		if (!(SHIP_CLASS_NAMES as ReadonlyArray<string>).includes(token)) {
			return {
				_tag: "Rejected",
				reason: `"${value}" is no lane class this repo routes on (known: ${SHIP_CLASS_NAMES.join(", ")})`,
			};
		}
		if (!classes.includes(token)) classes.push(token);
	}
	return {_tag: "Classed", classes};
};

export type CauseResolution =
	| {readonly _tag: "Uncaused"}
	| {readonly _tag: "Caused"; readonly cause: ParkCause}
	| {readonly _tag: "Rejected"; readonly reason: string};

const isParkCause = (token: string): token is ParkCause => Object.hasOwn(PARK_CAUSES, token);

/**
 * Resolve one `--cause` against the event it rides on. Absent is legal and stays legal: a shell that
 * parks for a reason no recipe covers reports the bare `BLOCKED` it always did, and `classifyPark`
 * answers Novel for it exactly as before.
 *
 * A cause on a non-`BLOCKED` event is refused rather than dropped. Only a park has a cause to be
 * gone, so a `DONE` carrying one is a caller that misunderstood the field, and recording it would
 * seat a cause on a line no unpark will ever read.
 */
export const causeForEvent = (raw: string | null, event: OperatorEvent): CauseResolution => {
	if (raw === null) return {_tag: "Uncaused"};
	if (event !== "BLOCKED") {
		return {
			_tag: "Rejected",
			reason: `a cause names why a lane parked, and this token maps to ${event}, not BLOCKED — drop --cause "${raw}"`,
		};
	}
	const token = raw.trim().toLowerCase();
	return isParkCause(token)
		? {_tag: "Caused", cause: token}
		: {
				_tag: "Rejected",
				reason: `"${raw}" is no park cause this repo's recipes key on (known: ${PARK_CAUSE_TOKENS.join(", ")})`,
			};
};
