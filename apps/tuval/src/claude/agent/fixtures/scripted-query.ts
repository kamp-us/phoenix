/**
 * The scripted `Query` every unit test in this directory runs on, and the recording `AgentSdk` seam
 * that hands it over.
 *
 * It replays golden fixtures (`../../history/fixtures/PROVENANCE.md`) rather than hand-written
 * envelopes, and it records the control calls the layer makes — `close`, `interrupt`,
 * `setPermissionMode`, `setModel` — plus the `Options` it was opened with. That record is the assertion surface
 * for everything the layer is supposed to hand the SDK.
 *
 * It also models the one thing the SDK owns that a scripted generator otherwise would not: the
 * subprocess. Constructing the query calls the `spawnClaudeCodeProcess` on the `Options` it was
 * given, and `close()` kills what came back — the two halves of "the layer owns the subprocess for
 * the life of the Scope" that `fake-spawn.ts` records.
 */

import type {
	ModelInfo,
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
	/** Every model the layer switched to, in order, so a test asserts the live call was made. */
	readonly models: Array<string | undefined>;
	closes: number;
	interrupts: number;
	readonly child: SpawnedProcess | null;
}

/** How a scripted query behaves at the two seams a real one has: the handshake and the first turn. */
export interface ScriptedBehaviour {
	/**
	 * `true` withholds `opening` until the first user message is written, which is what the real CLI
	 * does in streaming-input mode — `init` is "session metadata the CLI emits at the start of each
	 * turn" (`sdk.d.ts`), and there is no turn before a prompt.
	 */
	readonly deferOpening?: boolean;
	/**
	 * `true` ends the query the moment it is opened, as a subprocess that died on spawn does — which
	 * takes the handshake down with it, exactly as tearing a real query down does.
	 */
	readonly endsAtOnce?: boolean;
	/** What `supportedModels()` answers. Absent is a CLI that offers none, which is the old shape. */
	readonly models?: ReadonlyArray<ModelInfo>;
}

export const scriptedQuery = (
	params: {readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options},
	opening: ReadonlyArray<SDKMessage>,
	behaviour: ScriptedBehaviour = {},
): ScriptedQuery => {
	const buffered: Array<SDKMessage> = behaviour.deferOpening === true ? [] : [...opening];
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
		models: [],
		closes: 0,
		interrupts: 0,
		child,
	};

	// The `initialize` control request, as a promise settled the way the SDK settles it: it comes
	// back on connect, and tearing the query down rejects it along with every other pending control
	// request (`sdk.mjs`, `performCleanup`). The `catch` is the SDK's own guard against an unhandled
	// rejection on a query nobody asked the handshake of.
	let refuseHandshake: ((cause: unknown) => void) | null = null;
	const handshake = new Promise<unknown>((resolve, reject) => {
		if (behaviour.endsAtOnce !== true) resolve({commands: [], agents: [], models: []});
		refuseHandshake = reject;
	});
	handshake.catch(() => {});

	const deliver = (message: SDKMessage | null): void => {
		const waiter = waiting;
		if (waiter === null) {
			if (message !== null) buffered.push(message);
			return;
		}
		waiting = null;
		waiter(message);
	};

	// The operator's turns are read off the input iterable exactly as the SDK reads them, so a test
	// asserts what `prompt` actually sent rather than what it meant to send.
	void (async () => {
		for await (const message of params.prompt) {
			const first = record.prompts.length === 0;
			record.prompts.push(message);
			if (first && behaviour.deferOpening === true) for (const frame of opening) deliver(frame);
		}
	})();

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

	const abandonHandshake = (): void =>
		refuseHandshake?.(new Error("Query closed before response received"));

	const query: ScriptedQuery = Object.assign(stream(), {
		initializationResult: () => handshake,
		interrupt: async () => {
			record.interrupts += 1;
			return undefined;
		},
		setPermissionMode: async (mode: PermissionMode) => {
			record.modes.push(mode);
		},
		setModel: async (model?: string) => {
			record.models.push(model);
		},
		supportedModels: async () => behaviour.models ?? [],
		close: () => {
			record.closes += 1;
			stopped = true;
			child?.kill("SIGTERM");
			abandonHandshake();
			deliver(null);
		},
		say: (message: SDKMessage) => deliver(message),
		stop: () => {
			stopped = true;
			abandonHandshake();
			deliver(null);
		},
		record,
	});

	if (behaviour.endsAtOnce === true) query.stop();
	return query;
};

export interface ScriptedSdk {
	readonly sdk: AgentSdk;
	/** The queries opened, in order. One `start` is one entry. */
	readonly opened: Array<ScriptedQuery>;
	/** The `getSessionMessages` calls, in order. */
	readonly reads: Array<{sessionId: string; dir: string | undefined}>;
}

export interface ScriptedSdkOptions extends ScriptedBehaviour {
	/** The messages a fresh `query()` puts on its stream, in order. */
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
				const query = scriptedQuery(params, options.opening, options);
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
