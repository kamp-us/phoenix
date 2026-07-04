/**
 * The report resolution state machine (ADR 0098 §3) as pure domain logic — the
 * transition rules, with no database or Effect. `content_report.status` is a
 * closed three-state set; a terminal transition is the only writer of the audit
 * triad, so "resolved but we don't know who/what" is unrepresentable.
 *
 *   open ──resolve(remove)──▶ resolved   (target removed via the 0096 substrate)
 *   open ──resolve(dismiss)─▶ dismissed (report unfounded, no action)
 *   resolved  ──reopen──▶ open            (a restore re-opens; bounded)
 *   dismissed ──reopen──▶ open
 *
 * Transitions are decided by `Match.tagsExhaustive` over the source status, so an
 * illegal transition (e.g. `resolved → dismissed`) is a compile error at the
 * `transition` site — the machine is a type, not a convention.
 */
import {Match} from "effect";

/**
 * The closed status set, as the one runtime tuple the `content_report.status`
 * D1 enum sources from (so the column can't drift from the machine). `open` is
 * the only non-terminal state.
 */
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * The outcome a terminal transition records — the persisted `resolution` column
 * value (a state the report reached; past tense), as the one runtime tuple the
 * `content_report.resolution` D1 enum sources from. A distinct axis from
 * {@link ResolveAction}: `removed` is the outcome under `status:"resolved"`,
 * `dismissed` the outcome under `status:"dismissed"`.
 */
export const RESOLUTIONS = ["removed", "dismissed"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * The verb a moderator chooses on an open report (the action they take; present
 * tense) — the wire/input axis. Deliberately off the `removed`/`dismissed`
 * outcome tokens AND the `dismissed` status token: a bare `remove`/`dismiss`
 * reads as an action, never an outcome or a status. `remove` soft-deletes the
 * target. The action→outcome map is `remove → removed` (status `resolved`) and
 * `dismiss → dismissed` (status `dismissed`).
 */
export type ResolveAction = "remove" | "dismiss";

/** A `Match`-able tagged view of a row's current status. */
type StatusTag =
	| {readonly _tag: "open"}
	| {readonly _tag: "resolved"}
	| {readonly _tag: "dismissed"};

const tagged = (status: ReportStatus): StatusTag => ({_tag: status});

export class IllegalTransition extends Error {
	readonly _tag = "IllegalTransition";
	// Explicit fields + body assignment, not a TS parameter property: alchemy deploy
	// loads the worker through Node's strip-only TS loader, which rejects parameter
	// properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). See #916 for a permanent guard.
	readonly from: ReportStatus;
	readonly intent: string;
	constructor(from: ReportStatus, intent: string) {
		super(`illegal report transition: ${intent} from '${from}'`);
		this.from = from;
		this.intent = intent;
	}
}

/**
 * `resolve(action)` is legal only from `open`. The `Match.tagsExhaustive` forces
 * every status to be addressed; re-resolving an already-terminal report is
 * rejected as an `IllegalTransition` rather than silently re-stamping the audit.
 */
export const resolve = (
	from: ReportStatus,
	action: ResolveAction,
): {status: ReportStatus; resolution: Resolution} =>
	Match.valueTags(tagged(from), {
		open: () =>
			action === "remove"
				? ({status: "resolved", resolution: "removed"} as const)
				: ({status: "dismissed", resolution: "dismissed"} as const),
		resolved: () => {
			throw new IllegalTransition(from, `resolve(${action})`);
		},
		dismissed: () => {
			throw new IllegalTransition(from, `resolve(${action})`);
		},
	});

/**
 * `reopen` is legal only from a terminal state (`resolved` | `dismissed`) — a
 * restore of a moderated entity reopens its report (ADR 0096 §4 ↔ 0098 §3).
 * Reopening an already-open report is an `IllegalTransition`.
 */
export const reopen = (from: ReportStatus): ReportStatus =>
	Match.valueTags(tagged(from), {
		open: () => {
			throw new IllegalTransition(from, "reopen");
		},
		resolved: () => "open" as const,
		dismissed: () => "open" as const,
	});

export const isTerminal = (status: ReportStatus): boolean => status !== "open";

/**
 * The terminal statuses a report can be reopened from, derived from the machine
 * ({@link isTerminal}) rather than hand-typed — so the SQL `reopen` guard sources
 * its "reopen only from a terminal state" set from the one machine, not a literal
 * that could drift from it (ADR 0098 §3). Narrowed to the terminal subtype.
 */
export const TERMINAL_STATUSES = REPORT_STATUSES.filter(isTerminal) as ReadonlyArray<
	Exclude<ReportStatus, "open">
>;

/** The outcome an action records, independent of any transition — the action→outcome map. */
export const outcomeOf = (action: ResolveAction): Resolution =>
	action === "remove" ? "removed" : "dismissed";
