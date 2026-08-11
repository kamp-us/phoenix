/**
 * The `eval-record` document — what one graded review run leaves behind, bound to the head it ran
 * against.
 *
 *     eval: RECORDED @ 03135b91 — review/skill 0.95 (19/20 cases, 1 unmeasured)
 *
 *     ```json
 *     { "sha": …, "recordedAt": …, "cell": …, "pins": …, "gradedRuns": …, "cases": [ … ] }
 *     ```
 *
 * The clause counts **cases, not invocations** — one graded case is one graded run at cell level, and
 * the five executions behind it live in its case block. Counting invocations would double-count
 * variance: a flaky 3-of-5 case would contribute three wins instead of one pass, which is what taking
 * a median was for. Ruled on #5258; ADR 0253 §5's `19/20 runs` example is wrong and is corrected
 * there, not here.
 *
 * ADR 0253 fixes every choice here — the `eval` root, the `RECORDED | UNRECORDABLE` token instead of
 * a polarity, the PR-comment home, and the field inventory. Two of its rules are the ones a future
 * editor is most likely to undo, so they are enforced by {@link read} rather than trusted:
 *
 * - **The token is not a polarity.** `PASS`/`FAIL` would have to mean *pass against what*, and the
 *   only candidate is the 90% bar that belongs to the merge gate (#4681). A marker spelled with one
 *   is `Malformed`, so the bar cannot re-enter through the record.
 * - **A stored aggregate whose inputs are absent is a number nobody can check** (ADR 0252 §1). Every
 *   aggregate here is re-derived from the fields beside it and refused when it disagrees — the case
 *   block's `dispersion` from its own run counts, and the cell's `gradedRuns` / `passedRuns` /
 *   `unmeasuredCases` / `passRate` from the case blocks themselves. So a record cannot publish a
 *   figure its own contents contradict, in either direction.
 *
 * The head binding is **reused, not re-invented**: `HeadSha`, `Clause` and `bindToHead` come from
 * `./verdict-marker.ts`, so there is one notion of "bound to a head" in the package. What is new is
 * the payload beneath the line, which is why this is a sibling module rather than a widening of that
 * one (ADR 0241).
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	CLAUSE_SEPARATOR,
	type Clause,
	clause,
	type HeadSha,
	headSha,
	sameHead,
} from "./verdict-marker.ts";

declare const RECORDED_AT: unique symbol;

/** An ISO-8601 UTC instant with a trailing `Z`. Branded so `Found` cannot carry `"this morning"`. */
export type RecordedAt = string & {readonly [RECORDED_AT]: true};

const RECORDED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const recordedAt = (raw: string): RecordedAt | null => {
	const value = raw.trim();
	return RECORDED_AT_RE.test(value) ? (value as RecordedAt) : null;
};

/** The marker's namespace — a root of its own, never a `review-*` member (ADR 0253 §1). */
export const EVAL_NAMESPACE = "eval";

/**
 * Whether a measurement exists, not whether it was any good.
 *
 * `RECORDED` carries whatever number the run produced, below-bar included. `UNRECORDABLE` is the run
 * that produced no measurement at all — never folded into a `0.0` rate, which would publish a
 * measurement nobody took (ADR 0092).
 */
export type EvalOutcome = "RECORDED" | "UNRECORDABLE";

export const EVAL_OUTCOMES = ["RECORDED", "UNRECORDABLE"] as const;

/** A case's median verdict. `unmeasured` is the case whose every run returned no verdict. */
export type CaseVerdict = "pass" | "fail" | "unmeasured";

const CASE_VERDICTS: ReadonlyArray<string> = ["pass", "fail", "unmeasured"];

/** The `(stage × surface × model)` cell one record measures — ADR 0243 §4's key, unchanged. */
export interface EvalRecordCell {
	readonly stage: string;
	/** The review surface whose grader produced the rows; `null` on every non-`review` stage. */
	readonly surface: string | null;
	readonly model: string;
}

/** #4637 ruling 4's model + CLI + harness triple, carried on every record. */
export interface EvalRecordPins {
	readonly model: string;
	readonly cli: string;
	readonly harness: string;
}

/** One graded case's five runs, spelled as ADR 0252 §1 defines them. */
export interface EvalCaseBlock {
	readonly caseId: number;
	readonly verdict: CaseVerdict;
	readonly runs: number;
	readonly passed: number;
	readonly noVerdict: number;
	readonly dispersion: number;
	/** One token per run, in run order: `pass`, `fail`, or `no-verdict:<reason>`. */
	readonly perRun: ReadonlyArray<string>;
}

/**
 * The record's payload.
 *
 * The two levels use two spellings on purpose (ADR 0253 §5): `gradedRuns` / `passedRuns` / `passRate`
 * are the *cell* aggregate and match `ScorecardCell`, so #4680 commits a row without renaming
 * anything; `runs` / `passed` / `dispersion` are the *case* block and match ADR 0252 §1.
 *
 * `unmeasuredCases` is carried as its own integer rather than left to prose, because it is the one
 * fact `gradedRuns` / `passedRuns` cannot express: a cell that graded three of four cases reports
 * `3/3 = 1.0`, and without this field the committed row (#4680) hides the case that never ran.
 */
export interface EvalRecordPayload {
	readonly sha: HeadSha;
	readonly recordedAt: RecordedAt;
	readonly cell: EvalRecordCell;
	readonly pins: EvalRecordPins;
	readonly gradedRuns: number;
	readonly passedRuns: number;
	readonly unmeasuredCases: number;
	readonly passRate: number;
	readonly cases: ReadonlyArray<EvalCaseBlock>;
}

export interface EvalRecord {
	readonly outcome: EvalOutcome;
	readonly sha: HeadSha;
	readonly clause: Clause;
	readonly payload: EvalRecordPayload;
}

export type EvalRecordRead = WireRead<EvalRecord>;

/** `dispersion` is the minority-verdict count over a case's runs (ADR 0252 §1). */
export const dispersionOf = (runs: number, passed: number): number =>
	Math.min(passed, runs - passed);

/** The rate as the record stores it: four decimal places, the precision ADR 0252 §3 settles on. */
export const roundRate = (rate: number): number => Math.round(rate * 10_000) / 10_000;

const MARKER_LINE = /^\s*(\*{0,2})\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const SEPARATOR = /^(?:—|–|--|-)\s*/;

const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

const malformed = (reason: string, evidence: string): EvalRecordRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

const takeToken = (rest: string): {readonly token: string; readonly after: string} => {
	const trimmed = rest.trimStart();
	const end = trimmed.search(/\s/);
	return end === -1
		? {token: trimmed, after: ""}
		: {token: trimmed.slice(0, end), after: trimmed.slice(end)};
};

const outcomeOf = (token: string): EvalOutcome | null => {
	const value = token.toUpperCase();
	return value === "RECORDED" || value === "UNRECORDABLE" ? value : null;
};

/** Compose the record: the marker line, then the payload as one fenced JSON object. */
export const emit = (record: EvalRecord): string =>
	[
		`${EVAL_NAMESPACE}: ${record.outcome} @ ${record.sha} ${CLAUSE_SEPARATOR} ${record.clause}`,
		"",
		"```json",
		`${JSON.stringify(record.payload, null, 2)}`,
		"```",
		"",
	].join("\n");

type PayloadRead =
	| {readonly _tag: "Payload"; readonly payload: EvalRecordPayload}
	| {readonly _tag: "No"; readonly reason: string};

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (source: Record<string, unknown>, key: string): string | null => {
	const value = source[key];
	return typeof value === "string" ? value : null;
};

const numberField = (source: Record<string, unknown>, key: string): number | null => {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readCaseBlock = (raw: unknown, index: number): EvalCaseBlock | string => {
	if (!isRecordObject(raw)) return `case block ${index} is not an object`;
	const caseId = numberField(raw, "caseId");
	if (caseId === null || !Number.isInteger(caseId)) {
		return `case block ${index} carries no integer caseId`;
	}
	const verdict = stringField(raw, "verdict");
	if (verdict === null || !CASE_VERDICTS.includes(verdict)) {
		return `case ${caseId}'s verdict is "${verdict}" — expected ${CASE_VERDICTS.join(", ")}`;
	}
	const runs = numberField(raw, "runs");
	const passed = numberField(raw, "passed");
	const noVerdict = numberField(raw, "noVerdict");
	const dispersion = numberField(raw, "dispersion");
	if (runs === null || passed === null || noVerdict === null || dispersion === null) {
		return `case ${caseId} is missing one of runs, passed, noVerdict, dispersion`;
	}
	const perRun = raw.perRun;
	if (!Array.isArray(perRun) || perRun.some((token) => typeof token !== "string")) {
		return `case ${caseId} carries no per-run token list`;
	}
	if (perRun.length !== runs) {
		return `case ${caseId} reports ${runs} run(s) and carries ${perRun.length} per-run token(s)`;
	}
	// Both aggregates are re-derived rather than trusted: a stored number whose inputs are right
	// there and disagree is worse than an absent one, because it reads as checked (ADR 0252 §1).
	if (dispersion !== dispersionOf(runs, passed)) {
		return `case ${caseId}'s dispersion is ${dispersion}; min(${passed}, ${runs} − ${passed}) is ${dispersionOf(runs, passed)}`;
	}
	// A run that returned no verdict stays in `runs` and never counts as passed (ADR 0253 §4), so
	// this bound is what forbids a record that quietly moved a dead invocation onto the passing side.
	if (passed + noVerdict > runs) {
		return `case ${caseId} reports ${passed} passed + ${noVerdict} no-verdict over ${runs} run(s)`;
	}
	return {
		caseId,
		verdict: verdict as CaseVerdict,
		runs,
		passed,
		noVerdict,
		dispersion,
		perRun: perRun as ReadonlyArray<string>,
	};
};

const readPayload = (text: string, outcome: EvalOutcome, markerSha: HeadSha): PayloadRead => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {_tag: "No", reason: "the payload fence does not hold JSON"};
	}
	if (!isRecordObject(parsed)) return {_tag: "No", reason: "the payload is not one JSON object"};

	const sha = headSha(stringField(parsed, "sha") ?? "");
	if (sha === null) return {_tag: "No", reason: "the payload names no head SHA"};
	if (!sameHead(sha, markerSha)) {
		return {
			_tag: "No",
			reason: `the payload is bound to ${sha} and the marker to ${markerSha} — one record, one head`,
		};
	}
	const at = recordedAt(stringField(parsed, "recordedAt") ?? "");
	if (at === null) {
		return {_tag: "No", reason: "recordedAt is not an ISO-8601 UTC instant with a trailing Z"};
	}

	const cellRaw = parsed.cell;
	if (!isRecordObject(cellRaw)) return {_tag: "No", reason: "the payload carries no cell object"};
	const stage = stringField(cellRaw, "stage");
	const model = stringField(cellRaw, "model");
	if (stage === null || stage.trim() === "" || model === null || model.trim() === "") {
		return {
			_tag: "No",
			reason: "the cell names no stage and model — a pass rate measures one cell",
		};
	}
	const surfaceRaw = cellRaw.surface;
	if (surfaceRaw !== null && typeof surfaceRaw !== "string") {
		return {_tag: "No", reason: "the cell's surface is neither a string nor null"};
	}

	const pinsRaw = parsed.pins;
	if (!isRecordObject(pinsRaw)) return {_tag: "No", reason: "the payload carries no pins object"};
	const pinModel = stringField(pinsRaw, "model");
	const pinCli = stringField(pinsRaw, "cli");
	const pinHarness = stringField(pinsRaw, "harness");
	if (pinModel === null || pinCli === null || pinHarness === null) {
		return {
			_tag: "No",
			reason: "pins must name the model, the CLI and the harness (#4637 ruling 4)",
		};
	}

	const gradedRuns = numberField(parsed, "gradedRuns");
	const passedRuns = numberField(parsed, "passedRuns");
	const unmeasuredCases = numberField(parsed, "unmeasuredCases");
	const passRate = numberField(parsed, "passRate");
	if (gradedRuns === null || passedRuns === null || unmeasuredCases === null || passRate === null) {
		return {
			_tag: "No",
			reason: "the payload is missing one of gradedRuns, passedRuns, unmeasuredCases, passRate",
		};
	}
	const casesRaw = parsed.cases;
	if (!Array.isArray(casesRaw)) return {_tag: "No", reason: "the payload carries no cases array"};
	const cases: Array<EvalCaseBlock> = [];
	for (const [index, raw] of casesRaw.entries()) {
		const block = readCaseBlock(raw, index);
		if (typeof block === "string") return {_tag: "No", reason: block};
		cases.push(block);
	}

	// The cell aggregate is re-derived from the case blocks, exactly as `readCaseBlock` re-derives a
	// case's dispersion from its runs. Without this the cell half of the promise above was false: a
	// record claiming 10/10 over blocks summing to 1/2 — or over an EMPTY `cases` array — read back
	// Found, publishing a measurement nobody took as if it had been checked (review-code on #5401).
	const gradedCases = cases.filter((block) => block.verdict !== "unmeasured");
	const derivedPassed = gradedCases.filter((block) => block.verdict === "pass").length;
	if (gradedRuns !== gradedCases.length) {
		return {
			_tag: "No",
			reason: `gradedRuns is ${gradedRuns}; the case blocks carry ${gradedCases.length} graded case(s)`,
		};
	}
	if (passedRuns !== derivedPassed) {
		return {
			_tag: "No",
			reason: `passedRuns is ${passedRuns}; the case blocks carry ${derivedPassed} passing case(s)`,
		};
	}
	if (unmeasuredCases !== cases.length - gradedCases.length) {
		return {
			_tag: "No",
			reason: `unmeasuredCases is ${unmeasuredCases}; the case blocks carry ${cases.length - gradedCases.length}`,
		};
	}

	// The token and the denominator are one fact: `RECORDED` over nothing is the vacuous green ADR
	// 0092 forbids, and `UNRECORDABLE` over a real denominator hides a measurement that exists.
	if (outcome === "RECORDED" && gradedRuns === 0) {
		return {_tag: "No", reason: "a RECORDED record over zero graded runs measures nothing"};
	}
	if (outcome === "UNRECORDABLE" && gradedRuns !== 0) {
		return {
			_tag: "No",
			reason: `an UNRECORDABLE record reports ${gradedRuns} graded run(s) — that is a measurement`,
		};
	}
	const derived = gradedRuns === 0 ? 0 : roundRate(passedRuns / gradedRuns);
	if (roundRate(passRate) !== derived) {
		return {
			_tag: "No",
			reason: `passRate is ${passRate}; ${passedRuns}/${gradedRuns} is ${derived}`,
		};
	}

	return {
		_tag: "Payload",
		payload: {
			sha,
			recordedAt: at,
			cell: {stage, surface: surfaceRaw ?? null, model},
			pins: {model: pinModel, cli: pinCli, harness: pinHarness},
			gradedRuns,
			passedRuns,
			unmeasuredCases,
			passRate,
			cases,
		},
	};
};

const fencedPayload = (
	lines: ReadonlyArray<string>,
):
	| {readonly _tag: "Json"; readonly text: string}
	| {readonly _tag: "No"; readonly reason: string} => {
	const open = lines.findIndex((line) => line.trim().startsWith("```"));
	if (open === -1) return {_tag: "No", reason: "the record carries no fenced JSON payload"};
	const close = lines.findIndex((line, index) => index > open && line.trim() === "```");
	if (close === -1) return {_tag: "No", reason: "the payload fence is never closed"};
	return {
		_tag: "Json",
		text: lines
			.slice(open + 1, close)
			.join("\n")
			.trim(),
	};
};

/**
 * Read an eval record out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * The walk is stepwise for `verdict-marker.ts`'s reason — a single alternation would collapse "the
 * token is a polarity" and "the payload disagrees with its own case blocks" into one non-match, and
 * naming which half drifted is the whole value of the refusal.
 */
export const read = (artifact: string): EvalRecordRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null) {
		return {_tag: "Absent", reason: "the artifact holds no non-blank line to carry a record"};
	}
	const matched = MARKER_LINE.exec(line);
	const namespace = matched?.[2]?.toLowerCase() ?? "";
	if (matched === null || !namespace.startsWith(EVAL_NAMESPACE)) {
		return {
			_tag: "Absent",
			reason: 'the first line does not open with an "eval:" namespace — no record of this format',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	if (namespace !== EVAL_NAMESPACE) {
		return malformed(
			`the namespace "${namespace}" is not the "eval" root — an eval record never wears a gate's namespace (ADR 0253 §1)`,
			evidence,
		);
	}

	const emphasis = matched[1] ?? "";
	const {token: outcomeToken, after: afterOutcome} = takeToken(matched[3] ?? "");
	if (outcomeToken === "") {
		return malformed(
			`"${EVAL_NAMESPACE}:" carries no outcome — expected ${EVAL_OUTCOMES.join(" or ")}`,
			evidence,
		);
	}
	const outcome = outcomeOf(outcomeToken);
	if (outcome === null) {
		return malformed(
			`"${outcomeToken}" is not an eval outcome — expected ${EVAL_OUTCOMES.join(" or ")}; a record carries no PASS/FAIL polarity, because the bar it would judge against belongs to the merge gate`,
			evidence,
		);
	}

	const bound = afterOutcome.trimStart();
	if (!bound.startsWith("@")) {
		return malformed(
			`the ${outcome} record is bound to no head SHA — a measurement with no "@ <sha>" attests no tree`,
			evidence,
		);
	}
	const {token: shaToken, after: afterSha} = takeToken(bound.slice(1));
	const sha = headSha(shaToken);
	if (sha === null) {
		return malformed(`"${shaToken}" is not a head SHA — expected 7–40 hex characters`, evidence);
	}

	const tail = afterSha.trim();
	const unemphasized =
		emphasis !== "" && tail.endsWith(emphasis) ? tail.slice(0, -emphasis.length) : tail;
	const text = clause(unemphasized.replace(SEPARATOR, ""));
	if (text === null) {
		return malformed(
			"the record carries no trailing clause — the one field that says what the measurement means to a human",
			evidence,
		);
	}

	const lines = artifact.split("\n");
	const markerAt = lines.findIndex((raw) => raw.trim() === line.trim());
	const fenced = fencedPayload(lines.slice(markerAt + 1));
	if (fenced._tag === "No") return malformed(fenced.reason, evidence);
	const payload = readPayload(fenced.text, outcome, sha);
	if (payload._tag === "No") return malformed(payload.reason, evidence);

	return {_tag: "Found", value: {outcome, sha, clause: text, payload: payload.payload}};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderRecord = (record: EvalRecord): NonEmptyReadonlyArray<string> => [
	`outcome\t${record.outcome}`,
	`sha\t${record.sha}`,
	`clause\t${record.clause}`,
	`recordedAt\t${record.payload.recordedAt}`,
	`cell\t${record.payload.cell.stage}\t${record.payload.cell.surface ?? ""}\t${record.payload.cell.model}`,
	`pins\t${record.payload.pins.model}\t${record.payload.pins.cli}\t${record.payload.pins.harness}`,
	`rate\t${record.payload.passedRuns}/${record.payload.gradedRuns}\t${record.payload.passRate}\tunmeasured ${record.payload.unmeasuredCases}`,
	...record.payload.cases.map(
		(block) =>
			`case\t${block.caseId}\t${block.verdict}\t${block.passed}/${block.runs}\tnoVerdict ${block.noVerdict}\tdispersion ${block.dispersion}\t${block.perRun.join(",")}`,
	),
];

export type EvalRecordFields =
	| {readonly _tag: "Fields"; readonly record: EvalRecord}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD = /^([a-zA-Z]+):\s*(.*)$/;

/**
 * Parse `emit`'s stdin: `outcome` / `sha` / `clause` one per line, then `payload:` whose block runs
 * to the end and holds the JSON object.
 *
 * Every rejection is a refusal rather than a default, for `verdict-marker.ts`'s reason: a record
 * composed with a field silently missing looks perfectly well-formed to whoever reads it back.
 */
export const parseFields = (fields: string): EvalRecordFields => {
	const values = new Map<string, string>();
	const payloadLines: Array<string> = [];
	let inPayload = false;
	for (const [index, raw] of fields.split("\n").entries()) {
		if (inPayload) {
			payloadLines.push(raw);
			continue;
		}
		const line = raw.trim();
		if (line === "") continue;
		const field = FIELD.exec(line);
		if (field?.[1] === undefined) {
			return {_tag: "Unusable", reason: `line ${index + 1} is not a "<field>: <value>" line`};
		}
		if (field[1] === "payload") {
			inPayload = true;
			continue;
		}
		values.set(field[1], field[2] ?? "");
	}

	const outcome = outcomeOf((values.get("outcome") ?? "").trim());
	if (outcome === null) {
		return {_tag: "Unusable", reason: `no outcome — expected ${EVAL_OUTCOMES.join(" or ")}`};
	}
	const sha = headSha(values.get("sha") ?? "");
	if (sha === null) return {_tag: "Unusable", reason: "no 7–40 hex head SHA"};
	const text = clause(values.get("clause") ?? "");
	if (text === null) return {_tag: "Unusable", reason: "the trailing clause is blank"};
	const payload = readPayload(payloadLines.join("\n").trim(), outcome, sha);
	if (payload._tag === "No") return {_tag: "Unusable", reason: `payload: ${payload.reason}`};

	return {_tag: "Fields", record: {outcome, sha, clause: text, payload: payload.payload}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.record)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderRecord(result.value)} : result;
};
