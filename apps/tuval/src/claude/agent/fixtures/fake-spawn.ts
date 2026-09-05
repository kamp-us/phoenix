/**
 * A `spawnClaudeCodeProcess` that records a spawn and a kill and never speaks the protocol.
 *
 * The subprocess test tier's budget does not apply here because nothing is spawned: there is no
 * child, no PATH lookup and no handshake, so "the layer owns the subprocess for the life of the
 * Scope" is asserted at ordinary unit speed. `.patterns/subprocess-test-budget.md` covers the
 * real-spawn tier, which this exists to stay out of.
 */

import {PassThrough} from "node:stream";
import type {SpawnedProcess, SpawnOptions} from "@anthropic-ai/claude-agent-sdk";

export interface FakeSpawn {
	readonly spawn: (options: SpawnOptions) => SpawnedProcess;
	/** Every spawn this fake was asked for, in order. */
	readonly spawns: Array<SpawnOptions>;
	readonly kills: Array<NodeJS.Signals>;
	/** Report an exit to whoever registered a listener, as a dying subprocess would. */
	readonly exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export const fakeSpawn = (): FakeSpawn => {
	const spawns: Array<SpawnOptions> = [];
	const kills: Array<NodeJS.Signals> = [];
	const listeners: Array<ExitListener> = [];

	// `on`/`once`/`off` are overloaded on `SpawnedProcess` (an `exit` listener and an `error` one),
	// and an object literal cannot declare an overload. Function declarations can, so the two
	// signatures are written out and the implementation keeps only the `exit` half — which is all
	// this fake ever calls.
	function on(event: "exit", listener: ExitListener): void;
	function on(event: "error", listener: (error: Error) => void): void;
	function on(event: "exit" | "error", listener: ExitListener | ((error: Error) => void)): void {
		if (event === "exit") listeners.push(listener as ExitListener);
	}

	function off(event: "exit", listener: ExitListener): void;
	function off(event: "error", listener: (error: Error) => void): void;
	function off(): void {}

	const child: SpawnedProcess = {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		killed: false,
		exitCode: null,
		signalCode: null,
		kill(signal: NodeJS.Signals) {
			kills.push(signal);
			return true;
		},
		on,
		once: on,
		off,
	};

	return {
		spawns,
		kills,
		spawn: (options) => {
			spawns.push(options);
			return child;
		},
		exit: (code, signal) => {
			for (const listener of listeners) listener(code, signal);
		},
	};
};
