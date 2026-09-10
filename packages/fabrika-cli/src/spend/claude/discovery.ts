import {Effect, FileSystem, Path, Result, Schema} from "effect";
import {decodeJson, NativeRow, sessionKey} from "./native.ts";

const Meta = Schema.Struct({toolUseId: Schema.String});
export interface Transcript {
	readonly child: string | null;
	readonly path: string;
	readonly rows: ReadonlyArray<typeof NativeRow.Type>;
	readonly state: "read" | "absent" | "unreadable";
	readonly malformed: boolean;
	readonly parentTool: string | null;
}

export const discover = Effect.fn("spend.claude.discover")(function* (
	root: string,
	rootPath: string,
	expected: ReadonlyMap<string, string>,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const paths = new Map<string | null, string>([[null, rootPath], ...expected]);
	const childRoot = path.join(rootPath.replace(/\.jsonl$/, ""), "subagents");
	const dirs = [childRoot];
	const visited = new Set<string>();
	let enumerated = true;
	while (dirs.length > 0) {
		const dir = dirs.pop() as string;
		const real = yield* Effect.result(fs.realPath(dir));
		if (Result.isFailure(real)) {
			if (real.failure.reason._tag !== "NotFound") enumerated = false;
			continue;
		}
		if (visited.has(real.success)) continue;
		visited.add(real.success);
		const entries = yield* Effect.result(fs.readDirectory(dir));
		if (Result.isFailure(entries)) {
			enumerated = false;
			continue;
		}
		for (const entry of entries.success.sort()) {
			const file = path.join(dir, entry);
			const stat = yield* Effect.result(fs.stat(file));
			if (Result.isFailure(stat)) {
				enumerated = false;
				continue;
			}
			if (stat.success.type === "Directory") {
				dirs.push(file);
				continue;
			}
			const match = /^agent-(.+)\.jsonl$/.exec(entry);
			if (match?.[1]) paths.set(match[1], file);
		}
	}
	const transcripts: Transcript[] = [];
	const parents = new Map<string, string>();
	for (const [child, file] of paths) {
		const read = yield* Effect.result(fs.readFileString(file));
		const rows: Array<typeof NativeRow.Type> = [];
		let malformed = false;
		if (Result.isSuccess(read)) {
			for (const line of read.success.split("\n").filter((line) => line.trim() !== "")) {
				const parsed = decodeJson(NativeRow, line);
				if (Result.isFailure(parsed)) {
					malformed = true;
					continue;
				}
				const row = parsed.success;
				if (row.sessionId !== root || (row.agentId ?? null) !== child) continue;
				rows.push(row);
				const blocks = row.message?.content;
				if (Array.isArray(blocks))
					for (const block of blocks) {
						if (
							block.type === "tool_use" &&
							block.id &&
							(block.name === "Agent" || block.name === "Task")
						)
							parents.set(block.id, sessionKey(root, child));
					}
			}
		}
		let parentTool: string | null = null;
		if (child !== null) {
			const metaText = yield* Effect.result(
				fs.readFileString(file.replace(/\.jsonl$/, ".meta.json")),
			);
			if (Result.isSuccess(metaText)) {
				const meta = decodeJson(Meta, metaText.success);
				if (Result.isSuccess(meta)) parentTool = meta.success.toolUseId;
			}
		}
		transcripts.push({
			child,
			path: file,
			rows,
			malformed,
			parentTool,
			state: Result.isSuccess(read)
				? "read"
				: read.failure.reason._tag === "NotFound"
					? "absent"
					: "unreadable",
		});
	}
	return {transcripts, parents, enumerated};
});
