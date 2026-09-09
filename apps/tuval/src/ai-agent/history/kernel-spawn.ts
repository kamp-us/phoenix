/**
 * Reading one settled tool row as a kernel spawn: which program it started, and which process it
 * got back.
 *
 * A layer's mapper is the only thing that can tell a kernel child from a worker its own backend
 * spawned, because the difference is *which tool the model called* — and each harness spells the
 * same tool differently on the wire. The two spellings both come from one server name here, so a
 * renamed server moves one constant and both mappers follow (`../../claude/tools/server.ts` derives
 * its own wire name from `KERNEL_TOOL_SERVER`, and `../../codex/tools.ts`'s rows arrive as
 * `<server>.<tool>` — `../../codex/history.ts`).
 *
 * The answer is read off the row's own result rather than off the bridge, because the mapper stands
 * where the transcript is and the bridge stands where the call was made. `read` walks the parsed
 * result for the one field the spawn spell answers with (`process`), including through the MCP
 * envelopes each harness wraps it in, because a tool result crosses the wire as text and each
 * harness wraps it its own way.
 */

import type {ToolItem} from "../ports/transcript-item.ts";

/** The MCP server both harnesses mount the kernel tools on. Half of every wire name below. */
export const KERNEL_TOOL_SERVER = "tuval";

const SPAWN = "spawn";

/**
 * How the spawn tool is named in a settled row, per harness: the SDK's `mcp__<server>__<tool>` and
 * Codex's `<server>.<tool>`. A bare `spawn` is deliberately not one of them — a backend's own
 * unrelated tool of that name would read as a kernel spawn.
 */
const SPAWN_NAMES: ReadonlySet<string> = new Set([
	`mcp__${KERNEL_TOOL_SERVER}__${SPAWN}`,
	`${KERNEL_TOOL_SERVER}.${SPAWN}`,
]);

/** What one settled kernel spawn says: the program asked for, and the process the kernel started. */
export interface KernelSpawn {
	/** The program id the call named. A row whose input carries none reads as the bare tool name. */
	readonly program: string;
	readonly process: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * How deep the walk goes into a result envelope before it gives up. Six is what the deepest live
 * shape costs: a JSON string, its object, its content array, an entry, that entry's own text, and
 * the object that text parses to.
 */
const DEPTH = 6;

/**
 * The `process` a decoded result carries, however the harness wrapped it. A string that parses as
 * JSON is walked too: an MCP content block carries the spell's own reply as text inside itself.
 */
const processIn = (value: unknown, depth: number): string | null => {
	if (depth > DEPTH) return null;
	if (typeof value === "string") {
		if (!value.trimStart().startsWith("{") && !value.trimStart().startsWith("[")) return null;
		try {
			return processIn(JSON.parse(value), depth + 1);
		} catch {
			return null;
		}
	}
	if (Array.isArray(value)) {
		for (const one of value) {
			const found = processIn(one, depth + 1);
			if (found !== null) return found;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	const own = value.process;
	if (typeof own === "string" && own.length > 0) return own;
	for (const key of ["result", "content", "contentItems", "text", "value"]) {
		const found = processIn(value[key], depth + 1);
		if (found !== null) return found;
	}
	return null;
};

const programIn = (input: unknown, fallback: string): string => {
	if (!isRecord(input)) return fallback;
	const program = input.program;
	return typeof program === "string" && program.length > 0 ? program : fallback;
};

/**
 * This row as a kernel spawn, or `null` when it is not one. A spawn that failed is not one either:
 * the kernel refused it, so there is no process to show and no row to open.
 */
export const kernelSpawnOf = (item: ToolItem): KernelSpawn | null => {
	if (!SPAWN_NAMES.has(item.name) || item.status !== "ok") return null;
	const process = processIn(item.result.text, 0);
	return process === null ? null : {program: programIn(item.input, SPAWN), process};
};
