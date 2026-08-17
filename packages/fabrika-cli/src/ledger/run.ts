/**
 * The run directory: where a planning run keeps everything, so nothing survives only in a model's head.
 *
 * **The key is the claim nonce, never the session.** Every sibling subagent of one session shares
 * `CLAUDE_CODE_SESSION_ID` (measured, #4500), so a session-keyed namespace collapses exactly the
 * isolation two parallel planning lanes need (#4516, #4544). The shipped precedent is
 * `build/scratch-verb.ts`.
 *
 * Four files, each named for what it holds, and between them they are the reason a compaction between
 * minting and splicing loses nothing: `run.json` (the run's identity, decided once by `ledger open`),
 * `plan.md` and `topology.md` (the staged documents `ledger write` splices), and `children.jsonl` (the
 * epic's **whole** child set — seeded from the live sub-issue list, appended to as children are minted).
 *
 * A manifest line that does not parse fails the read. It never resolves to "this run has no children":
 * an unreadable manifest and an empty one take opposite branches, and only one of them is a fact.
 */

import {isRecord, parseJson} from "../io/json.ts";

/** The directory the run tree lives under, inside the epic's tree. */
export const RUN_ROOT = ".fabrika-plan";

/**
 * The one line `ledger open` appends to `.git/info/exclude`.
 *
 * That file is per-checkout and untracked, so the exclusion never enters a diff and never fights a
 * `--require-clean` check.
 */
export const EXCLUDE_ENTRY = `${RUN_ROOT}/`;

/** The run key: `<epic>-<claim-nonce>`. */
export const runKey = (epic: number, nonce: string): string => `${epic}-${nonce}`;

/** The run’s directory inside the epic tree. */
export const runDir = (treeRoot: string, key: string): string =>
	`${treeRoot.replace(/\/+$/, "")}/${RUN_ROOT}/${key}`;

export const runJsonPath = (dir: string): string => `${dir}/run.json`;
export const planPath = (dir: string): string => `${dir}/plan.md`;
export const topologyPath = (dir: string): string => `${dir}/topology.md`;
export const manifestPath = (dir: string): string => `${dir}/children.jsonl`;

/** How the run's plan region is resolved — decided once, by `ledger open`, and never re-derived. */
export type PlanMode = "fresh" | "re-plan";

/** Whether the repository carries the cycle doc — the third value is the point (`plan/github.ts`). */
export type CycleDoc = "present" | "absent" | "unknown";

/**
 * `run.json` — what `ledger open` decided, read by every later verb.
 *
 * **`bodyDigest` is a record, never an input.** `draft` and `write` compare the live body against the
 * `--body-digest` *flag* and nothing else; a verb that fell back to the recorded value when the flag
 * was absent would compare the plan against itself and make the moved-epic check vacuous. The field is
 * here so a successor reading the directory can see what scope the run was opened over.
 */
export interface RunRecord {
	readonly epic: number;
	readonly run: string;
	readonly mode: PlanMode;
	readonly cycleDoc: CycleDoc;
	readonly bodyDigest: string;
}

export const renderRunRecord = (record: RunRecord): string => `${JSON.stringify(record)}\n`;

const isMode = (value: unknown): value is PlanMode => value === "fresh" || value === "re-plan";

const isCycleDoc = (value: unknown): value is CycleDoc =>
	value === "present" || value === "absent" || value === "unknown";

/** The record, or `null` when the bytes are not one — which every caller seats on `11`, never on a default. */
export const parseRunRecord = (text: string): RunRecord | null => {
	const value = parseJson(text);
	if (!isRecord(value)) return null;
	const {epic, run, mode, cycleDoc, bodyDigest} = value;
	if (typeof epic !== "number" || typeof run !== "string" || typeof bodyDigest !== "string") {
		return null;
	}
	return isMode(mode) && isCycleDoc(cycleDoc) ? {epic, run, mode, cycleDoc, bodyDigest} : null;
};

/**
 * One line of `children.jsonl`.
 *
 * `id` is the database id the create response carries, and it is recorded because the sub-issue link
 * and unlink both take it rather than the number. Without it on the manifest, `supersede` and any
 * later link retry would have to re-read GitHub for a value the run already held.
 */
export interface ChildRecord {
	readonly number: number;
	readonly id: number;
	readonly title: string;
	readonly type: string | null;
	readonly priority: string | null;
	readonly readyFor: string | null;
	readonly stories: ReadonlyArray<number> | null;
	readonly containment: string | null;
	readonly linked: boolean;
	/** A child this run minted. `supersede` refuses one — a re-plan does not retire its own work. */
	readonly mintedThisRun: boolean;
}

export const renderChildRecord = (record: ChildRecord): string => JSON.stringify(record);

export const renderManifest = (records: ReadonlyArray<ChildRecord>): string =>
	records.length === 0 ? "" : `${records.map(renderChildRecord).join("\n")}\n`;

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseChildRecord = (line: string): ChildRecord | null => {
	const value = parseJson(line);
	if (!isRecord(value)) return null;
	const {number, id, title, stories, linked, mintedThisRun} = value;
	if (typeof number !== "number" || typeof id !== "number") return null;
	const ids = Array.isArray(stories)
		? stories.every((s) => typeof s === "number")
			? (stories as ReadonlyArray<number>)
			: null
		: null;
	return {
		number,
		id,
		title: typeof title === "string" ? title : "",
		type: stringOrNull(value.type),
		priority: stringOrNull(value.priority),
		readyFor: stringOrNull(value.readyFor),
		stories: Array.isArray(stories) ? ids : null,
		containment: stringOrNull(value.containment),
		linked: linked === true,
		mintedThisRun: mintedThisRun === true,
	};
};

/** Every recorded child, or `null` when any non-blank line is not a record. */
export const parseManifest = (text: string): ReadonlyArray<ChildRecord> | null => {
	const records: ChildRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const record = parseChildRecord(line);
		if (record === null) return null;
		records.push(record);
	}
	return records;
};
