/**
 * The report resolution state machine (ADR 0098 §3) as pure domain logic — no database, no
 * Effect. A terminal transition is the only writer of the audit triad, so "resolved but we
 * don't know who/what" is unrepresentable.
 *
 *   open ──resolve(remove)──▶ resolved   (target removed via the 0096 substrate)
 *   open ──resolve(dismiss)─▶ dismissed (report unfounded, no action)
 *   resolved  ──reopen──▶ open            (a restore re-opens; bounded)
 *   dismissed ──reopen──▶ open
 *
 * An illegal transition is a typed `Result.Failure(IllegalTransition)`, never a `throw`: inside
 * an `Effect.fn` caller a throw becomes an untyped defect/500 (#2560).
 */
import {Match, Result} from "effect";

/** The one runtime tuple the `content_report.status` D1 enum sources from. */
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * The persisted `resolution` column value (the outcome reached; past tense) — a distinct axis
 * from {@link ResolveAction}, and the one runtime tuple that D1 enum sources from.
 */
export const RESOLUTIONS = ["removed", "dismissed"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * The verb a moderator chooses (present tense) — the wire/input axis, deliberately off the
 * outcome and status tokens so a bare `remove`/`dismiss` can't read as either.
 */
export type ResolveAction = "remove" | "dismiss";

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

/** Legal only from `open`; re-resolving a terminal report fails rather than re-stamping the audit. */
export const resolve = (
	from: ReportStatus,
	action: ResolveAction,
): Result.Result<{status: ReportStatus; resolution: Resolution}, IllegalTransition> =>
	Match.valueTags(tagged(from), {
		open: () =>
			Result.succeed(
				action === "remove"
					? ({status: "resolved", resolution: "removed"} as const)
					: ({status: "dismissed", resolution: "dismissed"} as const),
			),
		resolved: () => Result.fail(new IllegalTransition(from, `resolve(${action})`)),
		dismissed: () => Result.fail(new IllegalTransition(from, `resolve(${action})`)),
	});

/** Legal only from a terminal state — a restore reopens its report (ADR 0096 §4 ↔ 0098 §3). */
export const reopen = (from: ReportStatus): Result.Result<ReportStatus, IllegalTransition> =>
	Match.valueTags(tagged(from), {
		open: () => Result.fail(new IllegalTransition(from, "reopen")),
		resolved: () => Result.succeed("open" as const),
		dismissed: () => Result.succeed("open" as const),
	});

export const isTerminal = (status: ReportStatus): boolean => status !== "open";

/**
 * Derived from {@link isTerminal} rather than hand-typed, so the SQL `reopen` guard sources its
 * terminal set from the one machine (ADR 0098 §3).
 */
export const TERMINAL_STATUSES = REPORT_STATUSES.filter(isTerminal) as ReadonlyArray<
	Exclude<ReportStatus, "open">
>;

export const outcomeOf = (action: ResolveAction): Resolution =>
	action === "remove" ? "removed" : "dismissed";
