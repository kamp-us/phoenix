/** Audit create/recovery. Recovery never creates; an interleaved first create can still race. */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	addLabels,
	createUnlabelledIssue,
	getIssue,
	type IssueRecord,
	listAllIssueRecords,
	listLabels,
	resolveRepo,
} from "../io/issues.ts";
import {scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import * as audit from "../wire/audit-context.ts";
import {
	AUDIT_CLOSED,
	AUDIT_CONTEXT_CHANGED,
	AUDIT_MALFORMED,
	AUDIT_TOO_LARGE,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SESSION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {SESSION_LABEL} from "./session.ts";

export type AuditAttempt =
	| {readonly _tag: "Create"}
	| {readonly _tag: "Recover"; readonly session: number | null};

export interface AuditOpenOptions {
	readonly text: string;
	readonly attempt: AuditAttempt;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runAuditOpen = Effect.fn("grill.auditOpen")(function* (
	options: AuditOpenOptions,
): Effect.fn.Return<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> {
	const parsed = audit.parse(options.text);
	if (parsed._tag !== "Found") return refuse(AUDIT_MALFORMED, `grill open: ${parsed.reason}`);
	const context = parsed.value;
	const digest = audit.digest(context);
	const identity = `runId=${context.runId} digest=${digest}`;
	const body = `A grilling session. Audit recommendations are research, not human rulings.\n\n${audit.emit(context)}`;
	if (Buffer.byteLength(body, "utf8") > audit.BODY_LIMIT)
		return refuse(
			AUDIT_TOO_LARGE,
			`grill open: audit body exceeds ${audit.BODY_LIMIT} UTF-8 bytes; nothing written. ${identity}`,
		);
	if (scanBody(body).leaks.length > 0)
		return refuse(
			LEAKED_PATH,
			`grill open: audit context carries a machine-local path; nothing written. ${identity}`,
		);
	const final = audit.read(body);
	if (final._tag !== "Found" || audit.digest(final.value) !== digest)
		return refuse(
			AUDIT_MALFORMED,
			`grill open: composed audit context failed consumer validation. ${identity}`,
		);
	const resolved = yield* resolveRepo(options.repo, options.env);
	if (resolved._tag === "Failure")
		return refuse(PRECONDITION_UNKNOWN, `grill open: ${resolved.reason}`);
	const repo = resolved.value;
	if (context.repository !== repo)
		return refuse(
			AUDIT_MALFORMED,
			"grill open: audit repository differs from target repository; nothing written.",
		);
	const known = options.attempt._tag === "Recover" ? options.attempt.session : null;
	const evidence = (number: number, url: string) => `${identity} session=${number} url=${url}`;

	const verify = Effect.fn("grill.verifyAudit")(function* (
		number: number,
		url: string,
		created: boolean,
	): Effect.fn.Return<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> {
		const record = yield* getIssue(repo, number);
		const retained = evidence(number, url);
		if (record._tag !== "Present")
			return refuse(
				READBACK_MISMATCH,
				`grill open: audit readback ${record._tag}; recover this issue directly. ${retained}`,
			);
		const actual = audit.read(record.value.body);
		if (actual._tag !== "Found")
			return refuse(
				AUDIT_MALFORMED,
				`grill open: audit readback ${actual._tag}: ${actual.reason}. ${retained}`,
			);
		if (
			record.value.isPullRequest ||
			actual.value.runId !== context.runId ||
			audit.digest(actual.value) !== digest
		)
			return refuse(
				AUDIT_CONTEXT_CHANGED,
				`grill open: retained context differs; no overwrite or new issue. ${retained}`,
			);
		if (record.value.state !== "open")
			return refuse(
				AUDIT_CLOSED,
				`grill open: matching audit session is closed; it was not reopened. ${retained}`,
			);
		if (!record.value.labels.includes(SESSION_LABEL)) {
			const labelled = yield* addLabels(repo, number, [SESSION_LABEL]);
			const after = yield* getIssue(repo, number);
			if (after._tag !== "Present")
				return refuse(
					WRITE_UNKNOWN,
					`grill open: label/readback is UNKNOWN; recover this issue directly. ${retained}`,
				);
			const checked = audit.read(after.value.body);
			if (
				checked._tag !== "Found" ||
				audit.digest(checked.value) !== digest ||
				after.value.state !== "open" ||
				after.value.isPullRequest
			)
				return refuse(
					READBACK_MISMATCH,
					`grill open: context changed during label recovery. ${retained}`,
				);
			if (!after.value.labels.includes(SESSION_LABEL))
				return refuse(
					WRITE_UNKNOWN,
					`grill open: label is absent after ${labelled._tag}; recover this issue directly. ${retained}`,
				);
		}
		return answer(
			JSON.stringify({
				session: number,
				url: record.value.url,
				created,
				runId: context.runId,
				digest,
			}),
			[`grill open: verified audit context and session label. ${retained}`],
		);
	});

	if (known !== null)
		return yield* verify(known, `https://github.com/${repo}/issues/${known}`, false);

	const matches = (
		rows: ReadonlyArray<IssueRecord>,
	): {readonly rows: ReadonlyArray<IssueRecord>} | VerbOutcome => {
		const selected: IssueRecord[] = [];
		for (const row of rows) {
			const value = audit.read(row.body);
			if (value._tag === "Malformed")
				return refuse(
					AUDIT_MALFORMED,
					`grill open: cannot exclude malformed audit context on session=${row.number} url=${row.url}; nothing created. ${identity}`,
				);
			if (value._tag === "Found" && value.value.runId === context.runId) selected.push(row);
		}
		return {rows: selected};
	};
	const readMatches = Effect.fn("grill.auditMatches")(function* () {
		const rows = yield* listAllIssueRecords(repo);
		return rows._tag === "Failure"
			? refuse(
					PRECONDITION_UNKNOWN,
					`grill open: complete audit identity read is UNKNOWN: ${rows.reason}. ${identity}`,
				)
			: matches(rows.value);
	});
	const resolveMatches = Effect.fn("grill.resolveAuditMatches")(function* (
		rows: ReadonlyArray<IssueRecord>,
		created: boolean,
	) {
		if (rows.length > 1)
			return refuse(
				SESSION_AMBIGUOUS,
				`grill open: duplicate audit identity: ${rows.map((row) => evidence(row.number, row.url)).join("; ")}`,
			);
		const row = rows[0];
		return row === undefined
			? refuse(
					WRITE_UNKNOWN,
					`grill open: audit session not found; creation remains UNKNOWN. Recover with this same context; never create again. ${identity}`,
				)
			: yield* verify(row.number, row.url, created);
	});
	const first = yield* readMatches();
	if ("code" in first) return first;
	if (first.rows.length > 0 || options.attempt._tag === "Recover")
		return yield* resolveMatches(first.rows, false);
	const labels = yield* listLabels(repo);
	if (labels._tag === "Failure")
		return refuse(PRECONDITION_UNKNOWN, `grill open: labels unreadable. ${identity}`);
	if (!labels.value.includes(SESSION_LABEL))
		return refuse(NO_TARGET, `grill open: session label does not exist. ${identity}`);
	if (context.predecessor !== null) {
		const previous = yield* getIssue(repo, context.predecessor);
		if (previous._tag === "Unknown")
			return refuse(PRECONDITION_UNKNOWN, `grill open: predecessor read is UNKNOWN. ${identity}`);
		if (
			previous._tag === "Absent" ||
			!previous.value.labels.includes(SESSION_LABEL) ||
			previous.value.isPullRequest
		)
			return refuse(NO_TARGET, `grill open: predecessor is not a session. ${identity}`);
		const priorContext = audit.read(previous.value.body);
		if (priorContext._tag !== "Found" || priorContext.value.runId === context.runId)
			return refuse(
				AUDIT_MALFORMED,
				`grill open: predecessor must be a distinct audit run. ${identity}`,
			);
	}
	const second = yield* readMatches();
	if ("code" in second) return second;
	if (second.rows.length > 0) return yield* resolveMatches(second.rows, false);
	const created = yield* createUnlabelledIssue(repo, `Architecture audit: ${context.folder}`, body);
	if (created._tag === "Failure") {
		const recovered = yield* readMatches();
		return "code" in recovered ? recovered : yield* resolveMatches(recovered.rows, false);
	}
	return yield* verify(created.value.number, created.value.url, true);
});
