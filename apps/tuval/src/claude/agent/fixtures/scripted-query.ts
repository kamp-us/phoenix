/**
 * The scripted `Query` every unit test in this directory runs on, and the recording `AgentSdk` seam
 * that hands it over.
 *
 * It replays golden fixtures (`../../history/fixtures/PROVENANCE.md`) rather than hand-written
 * envelopes, and it records the control calls the layer makes — `close`, `interrupt`,
 * `setPermissionMode` — plus the `Options` it was opened with. That record is the assertion surface
 * for everything the layer is supposed to hand the SDK.
 *
 * It also models the one thing the SDK owns that a scripted generator otherwise would not: the
 * subprocess. Constructing the query calls the `spawnClaudeCodeProcess` on the `Options` it was
 * given, and `close()` kills what came back — the two halves of "the layer owns the subprocess for
 * the life of the Scope" that `fake-spawn.ts` records.
 */

import type {
	Options,
	PermissionMode,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
	SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {AgentSdk, AgentSession} from "../sdk.ts";

/** What the script does at each step: hand over a message, or wait for the test to say. */
export interface ScriptedQuery extends AgentSession {
	/** Push one more message onto the stream after `start` has already returned. */
	readonly say: (message: SDKMessage) => void;
	/** End the generator. A run that never sent a `result` is a subprocess that died mid-turn. */
	readonly stop: () => void;
	readonly record: QueryRecord;
}

export interface QueryRecord {
	readonly options: Options;
	readonly prompts: Array<SDKUserMessage>;
	readonly modes: Array<string>;
	closes: number;
	interrupts: number;
	readonly child: SpawnedProcess | null;
}

export const scriptedQuery = (
	params: {readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options},
	opening: ReadonlyArray<SDKMessage>,
): ScriptedQuery => {
	const buffered: Array<SDKMessage> = [...opening];
	let waiting: ((message: SDKMessage | null) => void) | null = null;
	let stopped = false;

	const child =
		params.options.spawnClaudeCodeProcess === undefined
			? null
			: params.options.spawnClaudeCodeProcess({
					command: "claude",
					args: ["--print"],
					env: params.options.env ?? {},
					signal: new AbortController().signal,
				});

	const record: QueryRecord = {
		options: params.options,
		prompts: [],
		modes: [],
		closes: 0,
		interrupts: 0,
		child,
	};

	// The operator's turns are read off the input iterable exactly as the SDK reads them, so a test
	// asserts what `prompt` actually sent rather than what it meant to send.
	void (async () => {
		for await (const message of params.prompt) record.prompts.push(message);
	})();

	const deliver = (message: SDKMessage | null): void => {
		const waiter = waiting;
		if (waiter === null) {
			if (message !== null) buffered.push(message);
			return;
		}
		waiting = null;
		waiter(message);
	};

	const next = (): Promise<SDKMessage | null> => {
		const held = buffered.shift();
		if (held !== undefined) return Promise.resolve(held);
		if (stopped) return Promise.resolve(null);
		return new Promise((resolve) => {
			waiting = resolve;
		});
	};

	// A real async generator rather than a hand-written iterator: `Query` extends
	// `AsyncGenerator<SDKMessage, void>`, and only the language's own generator satisfies every
	// overload of `next`/`return`/`throw` without a cast.
	async function* stream(): AsyncGenerator<SDKMessage, void> {
		while (true) {
			const message = await next();
			if (message === null) return;
			yield message;
		}
	}

	const query: ScriptedQuery = Object.assign(stream(), {
		interrupt: async () => {
			record.interrupts += 1;
			return undefined;
		},
		setPermissionMode: async (mode: PermissionMode) => {
			record.modes.push(mode);
		},
		close: () => {
			record.closes += 1;
			stopped = true;
			child?.kill("SIGTERM");
			deliver(null);
		},
		say: (message: SDKMessage) => deliver(message),
		stop: () => {
			stopped = true;
			deliver(null);
		},
		record,
	});

	return query;
};

export interface ScriptedSdk {
	readonly sdk: AgentSdk;
	/** The queries opened, in order. One `start` is one entry. */
	readonly opened: Array<ScriptedQuery>;
	/** The `getSessionMessages` calls, in order. */
	readonly reads: Array<{sessionId: string; dir: string | undefined}>;
}

export interface ScriptedSdkOptions {
	/** The messages a fresh `query()` replays before the layer stops reading, ending with `init`. */
	readonly opening: ReadonlyArray<SDKMessage>;
	/** What `getSessionMessages` answers. Absent answers an empty session, which is the resume miss. */
	readonly rows?: ReadonlyArray<SessionMessage>;
	/** A read that throws instead of answering. */
	readonly readFails?: Error;
	readonly version?: string;
}

export const scriptedSdk = (options: ScriptedSdkOptions): ScriptedSdk => {
	const opened: Array<ScriptedQuery> = [];
	const reads: Array<{sessionId: string; dir: string | undefined}> = [];
	return {
		opened,
		reads,
		sdk: {
			version: options.version ?? "0.0.0-scripted",
			query: (params) => {
				const query = scriptedQuery(params, options.opening);
				opened.push(query);
				return query;
			},
			getSessionMessages: async (sessionId, read) => {
				reads.push({sessionId, dir: read.dir});
				if (options.readFails !== undefined) throw options.readFails;
				return options.rows ?? [];
			},
		},
	};
};
