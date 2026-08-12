/**
 * The sidecar run manifest — which session produced which run of which case (#5439).
 *
 * A graded run mints a session id per invocation, spends it on `--session-id` so the transcript is
 * locatable, and used to drop it. So a recorded verdict could be read but never traced: the only way
 * to say which of a case's five runs produced which artifact was to sort artifacts by file mtime, an
 * inference two separate investigations had to make and flag as one.
 *
 * This is the missing landing place, and it is deliberately **beside** the eval record rather than
 * inside it. The record's field inventory is governed by ADR
 * [0253](../../../../.decisions/0253-eval-record-is-an-eval-namespaced-pr-comment.md), so adding a
 * field there is an amendment question; identity needs no such permission to be written down next to
 * it. Nothing here imports or widens the record shape — it only reads the case blocks back to check
 * that the two agree.
 *
 * The rows carry no transcript path and no working directory. Both are absolute, machine-local and
 * perishable, and this file is meant to be committed alongside the artifacts under
 * `claude-plugins/fabrika/reports/eval/`. The session id is the durable key: it is what the transcript
 * is named after, so a reader who still has the machine can find the transcript from the row, and a
 * reader who does not still knows exactly which session to ask for.
 */
import type {EvalCaseBlock, EvalRecordCell} from "../wire/eval-record.ts";

/** One run of one case, named. `verdict` is the same token the record's `perRun` carries. */
export interface RunIdentity {
	readonly caseId: number;
	/** 1-based, matching `RunOnce`'s `run` and the position in the record's `perRun` list. */
	readonly run: number;
	/** The id the candidate was spawned under (`claude -p --session-id`), and its transcript's name. */
	readonly sessionId: string;
	readonly model: string;
	readonly verdict: string;
}

/** One graded run's identity sidecar: the same head and cell the record attests, plus the rows. */
export interface RunManifest {
	readonly sha: string;
	readonly recordedAt: string;
	readonly cell: EvalRecordCell;
	readonly runs: ReadonlyArray<RunIdentity>;
}

/**
 * Where the manifest lands, given where the record's bytes were written.
 *
 * Derived rather than flagged on purpose: the whole defect is that identity was separable from the
 * number, so a run that persists a record persists its identity in the same act. An operator who can
 * forget the second flag is an operator who will.
 */
export const runManifestPathFor = (recordOut: string): string =>
	`${recordOut.replace(/\.[^./\\]*$/, "")}.runs.json`;

const rowsOfCase = (manifest: RunManifest, caseId: number): ReadonlyArray<RunIdentity> =>
	manifest.runs.filter((row) => row.caseId === caseId).sort((a, b) => a.run - b.run);

/**
 * Why the manifest and the record disagree, or `null` when they agree row for row.
 *
 * The manifest is only worth committing if it names the runs the record counted, so it is checked
 * against the record's own case blocks rather than trusted — the same re-derive-don't-trust stance
 * ADR 0252 §1 takes inside the record. A disagreement is a bug in the wiring, and the honest response
 * is to write nothing and say so: a manifest that names the wrong session is worse than none, because
 * a later reader has no way to tell.
 *
 * Zero rows against a non-empty case list is a disagreement, not a vacuous pass (ADR 0092).
 */
export const runManifestDisagreement = (
	manifest: RunManifest,
	cases: ReadonlyArray<EvalCaseBlock>,
): string | null => {
	if (cases.length > 0 && manifest.runs.length === 0) {
		return `the record carries ${cases.length} case(s) and the manifest names no run`;
	}
	const known = new Set(cases.map((block) => block.caseId));
	for (const row of manifest.runs) {
		if (!known.has(row.caseId)) {
			return `the manifest names case ${row.caseId}, which the record does not`;
		}
		if (row.sessionId.trim() === "") {
			return `case ${row.caseId} run ${row.run} names no session — an unnamed run is what this file exists to prevent`;
		}
	}
	for (const block of cases) {
		const rows = rowsOfCase(manifest, block.caseId);
		if (rows.length !== block.runs) {
			return `case ${block.caseId} ran ${block.runs} time(s) and the manifest names ${rows.length}`;
		}
		for (const [index, row] of rows.entries()) {
			if (row.run !== index + 1) {
				return `case ${block.caseId}'s runs are numbered ${rows.map((each) => each.run).join(", ")} — expected 1…${block.runs}`;
			}
			const token = block.perRun[index];
			if (row.verdict !== token) {
				return `case ${block.caseId} run ${row.run} is \`${row.verdict}\` in the manifest and \`${token}\` in the record`;
			}
		}
	}
	return null;
};

/** The committed bytes: tab-indented, one trailing newline — the way biome formats committed JSON. */
export const toJson = (manifest: RunManifest): string =>
	`${JSON.stringify(manifest, null, "\t")}\n`;
