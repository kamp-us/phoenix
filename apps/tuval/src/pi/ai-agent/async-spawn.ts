/**
 * A detached (`async: true`) spawn call → the worker run ids and agent name its slot reads by.
 *
 * A foreground spawn tells the parent session its run id on a `tool_execution_update`
 * (`../server/AgentSessionHost.ts`'s `runDetails`). An async launch emits none, so the only key the
 * row still holds is its own `toolCallId` — and `pi-subagents` writes an index for exactly that:
 * `updateActiveRunIndex` drops an empty alias file at
 * `<asyncRunRoot>/.active-runs/tool-calls/<encodeIndexSegment(toolCallId)>/<asyncRunId>` while the
 * run is queued or running (`src/runs/background/active-run-index.ts:18-24,79-95`), and both launch
 * sites pass the call id. `indexedToolCallIdAsyncLocations`
 * (`src/runs/background/run-id-resolver.ts:67-87`) is the read this mirrors: take the alias entries,
 * read each run's `status.json`, and trust a run only when its own `toolCallId` is the one asked
 * for. The alias is a hint; the status is the proof.
 *
 * `AsyncStatus.steps[]` (`src/shared/types.ts:1861-1899`) is then the parent-call-to-worker map: each
 * step names its `agent` and its own child `runId`, which is the `<runId>_<agent>_transcript.jsonl`
 * prefix `child-transcript.ts` already reads by.
 *
 * Nothing here imports `pi-subagents` — the package ships raw TypeScript and Tuval loads it by path
 * only (`../server/subagents.ts`). The grammar is small and versioned, so it is reimplemented, and
 * every read is total: a missing marker, an unreadable status or a status naming another call all
 * answer "no workers found" rather than throwing at a fold.
 */

import {createHash} from "node:crypto";
import {readdirSync, readFileSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join, resolve} from "node:path";

/** What one resolved async call contributes to its row: whose artifacts to read, and its name. */
export interface AsyncSpawn {
	readonly runIds: ReadonlyArray<string>;
	/** The agents the resolved steps report, or `null` when they name none. */
	readonly agent: string | null;
}

/** Resolved async calls by the `toolCallId` each was launched under. */
export type AsyncSpawns = ReadonlyMap<string, AsyncSpawn>;

const MAX_INDEX_SEGMENT_BYTES = 255;
const HASHED_INDEX_SEGMENT_PREFIX = "~sha256-";
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const hashedSegment = (value: string): string =>
	`${HASHED_INDEX_SEGMENT_PREFIX}${createHash("sha256").update(value).digest("hex")}`;

const isPortableSegment = (value: string): boolean =>
	value.length > 0 &&
	value !== "." &&
	value !== ".." &&
	!value.endsWith(".") &&
	!WINDOWS_RESERVED_NAME.test(value) &&
	!/%5C/i.test(value) &&
	!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(value);

/**
 * The directory name one tool call's aliases live under — `src/runs/background/index-segment.ts`'s
 * `encodeIndexSegment`. Reimplemented rather than approximated by `encodeURIComponent`, because the
 * writer falls back to a digest for anything a `readdir` could refuse on Windows, and a reader that
 * only ever spells the encoded form would miss those runs entirely.
 */
export const encodeIndexSegment = (value: string): string => {
	let encoded: string;
	try {
		encoded = encodeURIComponent(value);
	} catch {
		return hashedSegment(value);
	}
	return Buffer.byteLength(encoded, "utf-8") <= MAX_INDEX_SEGMENT_BYTES &&
		isPortableSegment(encoded)
		? encoded
		: hashedSegment(value);
};

/** The pre-hash key, where it still fits — `index-segment.ts`'s `historicallyReadableSegment`. */
const historicalSegment = (value: string): string | undefined => {
	let encoded: string;
	try {
		encoded = encodeURIComponent(value);
	} catch {
		return undefined;
	}
	if (encoded.length === 0 || encoded === "." || encoded === ".." || encoded.endsWith("."))
		return undefined;
	if (WINDOWS_RESERVED_NAME.test(encoded)) return undefined;
	return Buffer.byteLength(encoded, "utf-8") > MAX_INDEX_SEGMENT_BYTES ? undefined : encoded;
};

/**
 * Every directory name this call's aliases could be under — `indexSegmentAliases`: the key the
 * current writer spells first, then the pre-hash one an older writer left behind. Read rather than
 * assumed away, so a run launched under a previous pin is still findable.
 */
export const indexSegmentAliases = (value: string): ReadonlyArray<string> => {
	const current = encodeIndexSegment(value);
	const historical = historicalSegment(value);
	return historical === undefined || historical === current ? [current] : [current, historical];
};

const sanitizeScopeSegment = (value: string): string =>
	value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "unknown";

/** `resolveTempScopeId` (`src/shared/types.ts:2683-2726`), down to the branches a desk can reach. */
const tempScopeId = (): string => {
	const uid = process.getuid?.();
	if (uid !== undefined) return `uid-${uid}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = process.env[key];
		if (value !== undefined && value !== "") return `user-${sanitizeScopeSegment(value)}`;
	}
	return `home-${sanitizeScopeSegment(homedir())}`;
};

/** `TEMP_ROOT_DIR` (`src/shared/types.ts:2733-2737`) — the parent both roots below hang off. */
const tempRoot = (): string => {
	const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	return configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${tempScopeId()}`);
};

/**
 * Where detached runs keep their status directories — `ASYNC_DIR`
 * (`src/shared/types.ts:2739`). It is process-scoped rather than session-scoped, so it is read
 * off the same environment the extension runs in: this process spawns the children.
 */
export const asyncRunRoot = (): string => join(tempRoot(), "async-subagent-runs");

/**
 * Where a finished run's result payload and its indexes live — `RESULTS_DIR`
 * (`src/shared/types.ts:2738`), the sibling of the run root under the same temp scope.
 */
export const asyncResultsRoot = (): string => join(tempRoot(), "async-subagent-results");

const ACTIVE_RUN_INDEX_DIR = ".active-runs";
const RESULT_INDEX_DIR = "result-index";
const TOOL_CALL_INDEX_DIR = "tool-calls";

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const stringOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

const aliasEntries = (root: string, segment: string): ReadonlyArray<string> => {
	try {
		return readdirSync(join(root, ACTIVE_RUN_INDEX_DIR, TOOL_CALL_INDEX_DIR, segment), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
};

/**
 * The async run ids the index aliases to this call — a hint, not yet a match. Sorted by run id
 * rather than left in `readdir` order, so two reads of one unchanged index answer identically.
 */
const aliasedRunDirs = (root: string, toolCallId: string): ReadonlyArray<string> =>
	[
		...new Set(indexSegmentAliases(toolCallId).flatMap((segment) => aliasEntries(root, segment))),
	].sort();

/**
 * The run ids the results-dir index files this call, read as JSON rather than by filename.
 *
 * `writeResultIndexForData` drops a `ResultIndexEntry` at
 * `<resultsRoot>/result-index/tool-calls/<encodeIndexSegment(toolCallId)>/<encoded runId>.json`
 * whenever a result payload carries a `toolCallId` (`src/runs/background/result-files.ts:103-108`,
 * `149-153`), and nothing on the terminal path removes it — which is what makes it the route home
 * for a run whose active alias is already gone. The entry's own `runId` is read rather than the
 * filename's stem, because the stem is an encoding of it and can be a digest.
 */
const indexedRunIds = (resultsRoot: string, toolCallId: string): ReadonlyArray<string> => {
	const found = new Set<string>();
	for (const segment of indexSegmentAliases(toolCallId)) {
		const dir = join(resultsRoot, RESULT_INDEX_DIR, TOOL_CALL_INDEX_DIR, segment);
		let names: ReadonlyArray<string>;
		try {
			names = readdirSync(dir, {withFileTypes: true})
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const name of names) {
			let entry: Record<string, unknown> | undefined;
			try {
				entry = objectOf(JSON.parse(readFileSync(join(dir, name), "utf-8")));
			} catch {
				continue;
			}
			const runId = entry === undefined ? undefined : stringOf(entry.runId);
			if (runId !== undefined) found.add(runId);
		}
	}
	return [...found];
};

/**
 * Every run directory worth confirming for this call — the live aliases, then the run ids the
 * results index still files under it. Both are hints keyed by the same run id, so the union is
 * taken once and a run in both is confirmed once. Sorted rather than left in `readdir` order, so
 * two reads of one unchanged pair of indexes answer identically.
 */
const candidateRunDirs = (
	root: string,
	toolCallId: string,
	resultsRoot: string,
): ReadonlyArray<string> =>
	[
		...new Set([...aliasedRunDirs(root, toolCallId), ...indexedRunIds(resultsRoot, toolCallId)]),
	].sort();

const readStatus = (dir: string): Record<string, unknown> | undefined => {
	try {
		return objectOf(JSON.parse(readFileSync(join(dir, "status.json"), "utf-8")));
	} catch {
		return undefined;
	}
};

/** One step's worker, where it names both halves — a step still pending names no run of its own. */
const stepWorker = (
	value: unknown,
): {readonly runId: string; readonly agent: string | undefined} | undefined => {
	const step = objectOf(value);
	if (step === undefined) return undefined;
	const runId = stringOf(step.runId);
	return runId === undefined ? undefined : {runId, agent: stringOf(step.agent)};
};

/**
 * The workers one async call started, or `null` when nothing on disk proves any.
 *
 * The status's own `toolCallId` is the confirmation: an alias directory is a filename and survives
 * a crash, so a run that does not claim this call is skipped rather than read. Several runs can
 * alias one call — a relaunch under the same row — and every confirmed one contributes its steps,
 * in run-id order.
 *
 * The whole status is re-read on every call, so the answer always carries every step that has
 * launched so far. That is what makes a sequential lane's later steps arrive at all: a step is
 * declared up front with no `runId` and gains one when it launches (#8684).
 *
 * The alias index is not the only key tried, because `releaseActiveRunIndex` deletes this call's
 * alias the moment the run reaches a terminal state — the run directory and its `steps[]` survive,
 * but the way back to them does not. The results index does survive, so it is read beside the
 * aliases and confirmed by the same rule (#8685). `cleanupResultIndexes` ages those entries out at
 * 24h, past which a finished call resolves nothing and its row shows the result text alone.
 */
export const readAsyncSpawn = (
	root: string,
	toolCallId: string,
	resultsRoot: string = asyncResultsRoot(),
): AsyncSpawn | null => {
	const runIds: Array<string> = [];
	const agents: Array<string> = [];
	for (const entry of candidateRunDirs(root, toolCallId, resultsRoot)) {
		const status = readStatus(join(root, entry));
		if (status === undefined || stringOf(status.toolCallId) !== toolCallId) continue;
		const steps = Array.isArray(status.steps) ? status.steps : [];
		for (const step of steps) {
			const worker = stepWorker(step);
			if (worker === undefined) continue;
			if (!runIds.includes(worker.runId)) runIds.push(worker.runId);
			if (worker.agent !== undefined && !agents.includes(worker.agent)) agents.push(worker.agent);
		}
	}
	if (runIds.length === 0 && agents.length === 0) return null;
	return {runIds, agent: agents.length === 0 ? null : agents.join(", ")};
};

/** Every named call resolved fresh — the step the tail repeats beside its artifact read. */
export const readAsyncSpawns = (
	root: string,
	toolCallIds: ReadonlyArray<string>,
	resultsRoot: string = asyncResultsRoot(),
): AsyncSpawns => {
	const found = new Map<string, AsyncSpawn>();
	for (const toolCallId of toolCallIds) {
		const spawn = readAsyncSpawn(root, toolCallId, resultsRoot);
		if (spawn !== null) found.set(toolCallId, spawn);
	}
	return found;
};
