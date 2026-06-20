/**
 * The report resolution state machine (ADR 0098 §3) as pure domain logic — the
 * transition rules, with no database or Effect. `content_report.status` is a
 * closed three-state set; a terminal transition is the only writer of the audit
 * triad, so "resolved but we don't know who/what" is unrepresentable.
 *
 *   open ──resolve(removed)──▶ resolved   (target removed via the 0096 substrate)
 *   open ──resolve(dismissed)─▶ dismissed (report unfounded, no action)
 *   resolved  ──reopen──▶ open            (a restore re-opens; bounded)
 *   dismissed ──reopen──▶ open
 *
 * Transitions are decided by `Match.tagsExhaustive` over the source status, so an
 * illegal transition (e.g. `resolved → dismissed`) is a compile error at the
 * `transition` site — the machine is a type, not a convention.
 */
import {Match} from "effect";

/** The closed status set. `open` is the only non-terminal state. */
export type ReportStatus = "open" | "resolved" | "dismissed";

/** The terminal decision a resolve records (also the `resolution` column value). */
export type Resolution = "removed" | "dismissed";

/** A moderator's action on an open report. `removed` soft-deletes the target. */
export type ResolveAction = "removed" | "dismissed";

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
		open: () => ({
			status: (action === "removed" ? "resolved" : "dismissed") as ReportStatus,
			resolution: action,
		}),
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
