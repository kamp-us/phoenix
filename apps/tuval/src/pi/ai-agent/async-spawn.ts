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

/**
 * Where detached runs keep their status directories — `ASYNC_DIR`
 * (`src/shared/types.ts:2730-2735`). It is process-scoped rather than session-scoped, so it is read
 * off the same environment the extension runs in: this process spawns the children.
 */
export const asyncRunRoot = (): string => {
	const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${tempScopeId()}`);
	return join(root, "async-subagent-runs");
};

const ACTIVE_RUN_INDEX_DIR = ".active-runs";
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
 */
export const readAsyncSpawn = (root: string, toolCallId: string): AsyncSpawn | null => {
	const runIds: Array<string> = [];
	const agents: Array<string> = [];
	for (const entry of aliasedRunDirs(root, toolCallId)) {
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
export const readAsyncSpawns = (root: string, toolCallIds: ReadonlyArray<string>): AsyncSpawns => {
	const found = new Map<string, AsyncSpawn>();
	for (const toolCallId of toolCallIds) {
		const spawn = readAsyncSpawn(root, toolCallId);
		if (spawn !== null) found.set(toolCallId, spawn);
	}
	return found;
};
