/**
 * The durable spend ledger — where a measured run's cost survives the shell that measured it (#5009).
 *
 * Before this, a spend row existed only for as long as the operator kept the `--out` file they named,
 * so every measurement was ephemeral — the persistence gap epic #4779 names. The ledger is **JSON
 * Lines**: one self-describing JSON object per line, appended, never rewritten. The format is chosen
 * for what a partial write does to it — a crash mid-line damages exactly that line, and the reader
 * below skips it — and for what evolution does to it: every line carries its own `v`, so a later
 * shape is a new version rather than a migration of the file.
 *
 * The one-way import edge is deliberate: this module reaches `spend/` and `io/` only, never `eval/`
 * (#5050). `LedgerRow` is therefore declared **structurally** rather than imported from the runner —
 * `eval`'s `SpendRow` satisfies it, and so does a synthetic row in a test — which is what lets the
 * roll-up read this ledger without depending on the eval harness that writes it.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {appendFile, type WriteFailed} from "../io/fs.ts";
import type {RunSpend, StageSpend} from "./token-spend.ts";

/**
 * The default ledger, stated repo-relative so no machine-local path literal reaches a source file.
 * It is gitignored: a measurement is per-machine evidence, not a committed artifact.
 */
export const DEFAULT_SPEND_LEDGER_PATH = ".fabrika/spend-ledger.jsonl";

/** The shape version stamped on every line — the seam a later row shape evolves through. */
export const LEDGER_ROW_VERSION = 1;

/**
 * One persisted run: its spend plus the identity of the work that produced it. Every attribution
 * field is on the row rather than in a file header, because a line has to stand on its own — a
 * number that cannot name what it measured is a number with no unit of work.
 */
export interface LedgerRow {
	readonly skillName: string;
	/** Provenance — the key the run was recorded under, never a pointer into the live stage table (#4977). */
	readonly stage: string;
	readonly caseId: number;
	readonly arm: string;
	readonly model: string;
	readonly sessionId: string;
	readonly cliVersion: string | null;
	/** ISO-8601 UTC, supplied by the caller — this core mints no time of its own. */
	readonly recordedAt: string;
	readonly spend: RunSpend;
}

/** What a read of the ledger text found, and how much of it it could not read. */
export interface LedgerRead {
	readonly rows: ReadonlyArray<LedgerRow>;
	/** Lines that were present but unreadable. Reported, never silently folded into "no rows". */
	readonly skipped: number;
}

/**
 * Encode rows as ledger lines. The fields are picked explicitly rather than spread, so the on-disk
 * shape is this module's and does not drift with whatever extra fields a caller's row carries.
 */
export const encodeSpendRows = (rows: ReadonlyArray<LedgerRow>): string =>
	rows
		.map((row) =>
			JSON.stringify({
				v: LEDGER_ROW_VERSION,
				skillName: row.skillName,
				stage: row.stage,
				caseId: row.caseId,
				arm: row.arm,
				model: row.model,
				sessionId: row.sessionId,
				cliVersion: row.cliVersion,
				recordedAt: row.recordedAt,
				spend: row.spend,
			}),
		)
		.map((line) => `${line}\n`)
		.join("");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Decode a persisted spend. A `Reconstructed` arm is accepted only when every component is a real
 * number: a half-decoded spend would put back the fabricated zero the three-arm union exists to keep
 * out, so a damaged one is skipped instead.
 */
const decodeSpend = (value: unknown): RunSpend | null => {
	if (!isRecord(value)) return null;
	if (value._tag === "TranscriptMissing") return {_tag: "TranscriptMissing"};
	if (value._tag === "NoBilledTurns") return {_tag: "NoBilledTurns"};
	if (value._tag !== "Reconstructed" || !isRecord(value.spend)) return null;
	const raw = value.spend;
	const input = num(raw.input);
	const cacheCreate = num(raw.cacheCreate);
	const cacheRead = num(raw.cacheRead);
	const output = num(raw.output);
	const billed = num(raw.billed);
	const exCacheRead = num(raw.exCacheRead);
	const assistantTurns = num(raw.assistantTurns);
	if (
		input === null ||
		cacheCreate === null ||
		cacheRead === null ||
		output === null ||
		billed === null ||
		exCacheRead === null ||
		assistantTurns === null
	) {
		return null;
	}
	const model = raw.model;
	if (model !== null && typeof model !== "string") return null;
	const spend: StageSpend = {
		input,
		cacheCreate,
		cacheRead,
		output,
		billed,
		exCacheRead,
		assistantTurns,
		model,
	};
	return {_tag: "Reconstructed", spend};
};

const decodeRow = (line: string): LedgerRow | null => {
	const decoded = Result.try({try: (): unknown => JSON.parse(line), catch: () => null});
	if (Result.isFailure(decoded)) return null;
	const parsed = decoded.success;
	if (!isRecord(parsed) || parsed.v !== LEDGER_ROW_VERSION) return null;
	const skillName = str(parsed.skillName);
	const stage = str(parsed.stage);
	const caseId = num(parsed.caseId);
	const arm = str(parsed.arm);
	const model = str(parsed.model);
	const sessionId = str(parsed.sessionId);
	const recordedAt = str(parsed.recordedAt);
	const spend = decodeSpend(parsed.spend);
	if (
		skillName === null ||
		stage === null ||
		caseId === null ||
		arm === null ||
		model === null ||
		sessionId === null ||
		recordedAt === null ||
		spend === null
	) {
		return null;
	}
	const cliVersion = parsed.cliVersion;
	if (cliVersion !== null && typeof cliVersion !== "string") return null;
	return {skillName, stage, caseId, arm, model, sessionId, cliVersion, recordedAt, spend};
};

/**
 * Read a ledger's text into the rows it holds plus the count of lines it could not read.
 *
 * Tolerant by construction: a crash between the bytes and the newline leaves a truncated tail, and a
 * second suite appends after it — so one damaged line must never cost the rows around it. A blank
 * line is nothing at all, not a skip; anything else that does not decode is counted and reported,
 * because "the file held 3 rows" and "the file held 3 rows and 40 I could not read" are different
 * facts and a caller that cannot see the gap will read the first as the whole ledger.
 */
export const readSpendLedger = (text: string): LedgerRead => {
	const rows: Array<LedgerRow> = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const row = decodeRow(trimmed);
		if (row === null) {
			skipped += 1;
			continue;
		}
		rows.push(row);
	}
	return {rows, skipped};
};

/**
 * Append a suite's rows to the ledger, creating it and its parent directory on first use. No rows
 * means no write at all — an empty file would claim a suite recorded something.
 */
export const appendSpendLedger = (
	path: string,
	rows: ReadonlyArray<LedgerRow>,
): Effect.Effect<void, WriteFailed, FileSystem.FileSystem | Path.Path> => {
	const text = encodeSpendRows(rows);
	return text === "" ? Effect.void : appendFile(path, text);
};

/**
 * Persist a suite's rows and return what the caller should say about it — no notes on success, one
 * note naming the path and the reason on failure.
 *
 * The error channel is `never` on purpose, and it is the whole contract: recording a measurement is a
 * by-product of a run that already finished, so a ledger that cannot be written must not become a way
 * for that run to fail (epic #4779's no-gate ruling). Returning the note rather than printing it is
 * what lets that promise be asserted without a process.
 */
export const persistSpendRows = (
	path: string,
	rows: ReadonlyArray<LedgerRow>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
	appendSpendLedger(path, rows).pipe(
		Effect.as<ReadonlyArray<string>>([]),
		Effect.catchTag("fabrika-cli/WriteFailed", (failure) =>
			Effect.succeed([
				`could not append the spend ledger at ${failure.path}: ${failure.reason} — the suite's result is unaffected.`,
			]),
		),
	);
