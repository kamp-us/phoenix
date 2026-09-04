/**
 * Watching the Claude Code subprocess exit, so a stream that stops mid-turn can say why.
 *
 * The SDK owns the subprocess: `query()` spawns it and `Query.close()` terminates it (`sdk.d.ts`,
 * "Close the query and terminate the underlying process"). The one place a consumer can observe it
 * is `Options.spawnClaudeCodeProcess`, which replaces the spawn outright. So this wraps a spawner
 * the row supplied rather than installing one: with no spawner the SDK's own local spawn stands,
 * which is what runs the `claude` on `PATH`, and the exit reason is simply unknown.
 *
 * Nothing here spawns anything. The wrapper registers one `exit` listener and records what it
 * hears, which is the whole of what a `TransportError`'s detail needs.
 */

import type {SpawnedProcess, SpawnOptions} from "@anthropic-ai/claude-agent-sdk";

export type SpawnClaudeCodeProcess = (options: SpawnOptions) => SpawnedProcess;

export interface ExitRecord {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export interface SubprocessWatch {
	readonly spawn: SpawnClaudeCodeProcess;
	/** The exit the child reported, or `null` while it is still running or never spawned. */
	readonly exit: () => ExitRecord | null;
}

/** The sentence a `TransportError` carries when the stream ended without a `result`. */
export const exitDetail = (exit: ExitRecord | null): string => {
	if (exit === null) {
		return "the Claude Code subprocess ended before the turn produced a result";
	}
	if (exit.signal !== null) {
		return `the Claude Code subprocess was killed by ${exit.signal} before the turn produced a result`;
	}
	return `the Claude Code subprocess exited with code ${exit.code ?? "unknown"} before the turn produced a result`;
};

export const watchSubprocess = (spawn: SpawnClaudeCodeProcess): SubprocessWatch => {
	let exit: ExitRecord | null = null;
	return {
		spawn: (options) => {
			const child = spawn(options);
			child.once("exit", (code, signal) => {
				exit = {code, signal};
			});
			return child;
		},
		exit: () => exit,
	};
};
