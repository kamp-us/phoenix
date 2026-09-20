import {Console, Effect, FileSystem, Path} from "effect";
import {collectCodex, readCodexInventory} from "./codex-collector.ts";
import type {CodexWork} from "./codex-records.ts";

export interface CodexDispatchCollection {
	readonly sessions: string;
	readonly ledger: string;
	readonly worktree: string;
	readonly work: CodexWork;
	readonly state: string;
}
export const collectCodexDispatch = Effect.fn("spend.collectCodexDispatch")(
	function* (options: CodexDispatchCollection) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		yield* fs.makeDirectory(options.state, {recursive: true});
		const binding = path.join(options.state, `${encodeURIComponent(options.worktree)}.json`);
		if (!(yield* fs.exists(binding)))
			yield* fs.writeFileString(binding, JSON.stringify(options), {flag: "wx"});
		const inventory = yield* readCodexInventory(options.sessions);
		const roots = [
			...new Set(
				inventory.sessions
					.filter((session) => session.cwd === options.worktree && session.parent === null)
					.map((session) => session.thread),
			),
		];
		const notices = [...inventory.notices];
		for (const rootThread of roots.length ? roots : [`dispatch:${options.worktree}`]) {
			const result = yield* collectCodex({...options, rootThread});
			notices.push(...result.notices);
		}
		for (const notice of new Set(notices)) yield* Console.warn(`Fabrika usage: ${notice}`);
	},
	Effect.catch(() =>
		Console.warn(
			"Fabrika usage recording failed; native records remain available for replay. Work is unchanged.",
		),
	),
);
