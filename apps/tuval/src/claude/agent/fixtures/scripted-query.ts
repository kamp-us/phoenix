/**
 * The scripted `Query` every unit test in this directory runs on, and the recording `AgentSdk` seam
 * that hands it over.
 *
 * It replays golden fixtures (`../../history/fixtures/PROVENANCE.md`) rather than hand-written
 * envelopes, and it records the control calls the layer makes — `close`, `interrupt`,
 * `setPermissionMode`, `setModel` — plus the `Options` it was opened with. That record is the
 * assertion surface for everything the layer is supposed to hand the SDK.
 *
 * It also models the one thing the SDK owns that a scripted generator otherwise would not: the
 * subprocess. Constructing the query calls the `spawnClaudeCodeProcess` on the `Options` it was
 * given, and `close()` kills what came back — the two halves of "the layer owns the subprocess for
 * the life of the Scope" that `fake-spawn.ts` records.
 */

import type {
	EffortLevel,
	ListSessionsOptions,
	ModelInfo,
	Options,
	PermissionMode,
	SDKMessage,
	SDKSessionInfo,
	SDKUserMessage,
	SessionMessage,
	SlashCommand,
	SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {AgentSdk, AgentSession} from "../sdk.ts";

/** What the script does at each step: hand over a message, or wait for the test to say. */
export interface ScriptedQuery extends AgentSession {
	/** Push one more message onto the stream after `start` has already returned. */
	readonly say: (message: SDKMessage) => void;
	/** End the generator. A run that never sent a `result` is a subprocess that died mid-turn. */
	readonly stop: () => void;
	/**
	 * Make the message iterator itself throw, which is the transport failing rather than the session
	 * ending — the one arm `stop` cannot script, and the only way into `streamFailed` (#8010).
	 */
	readonly fail: (cause: unknown) => void;
	readonly record: QueryRecord;
}

export interface QueryRecord {
	readonly options: Options;
	readonly prompts: Array<SDKUserMessage>;
	readonly modes: Array<string>;
	/** Every model the layer switched to, in order, so a test asserts the live call was made. */
	readonly models: Array<string | undefined>;
	/** Every effort level the layer applied, in order, for the same reason (#8062). */
	readonly efforts: Array<EffortLevel | null>;
	readonly contextReads: Array<{detail: "summary"}>;
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
	readonly runningModel?: string;
	readonly contextFails?: Error;
	/** A `setModel` the CLI refuses. The call is still recorded, so a test sees it was attempted. */
	readonly modelSwitchFails?: Error;
	/** An `applyFlagSettings` the CLI refuses, recorded the same way. */
	readonly effortSwitchFails?: Error;
	/** A `supportedModels()` that throws, which is a session with no picker rather than no session. */
	readonly catalogFails?: Error;
	/** What `supportedCommands()` answers. Absent is a CLI that offers none. */
	readonly commands?: ReadonlyArray<SlashCommand>;
	/** A `supportedCommands()` that throws — a session with no slash picker, not a failed open. */
	readonly commandsFail?: Error;
	/**
	 * An `interrupt()` the CLI refuses, recorded the same way a refused `setModel` is. The SDK's own
	 * rejection carries no account of why (`sdk.d.ts`, `Query.interrupt`), which is what makes the
	 * layer's reading of its own turn state the input the fold routes on (ADR 0356).
	 */
	readonly interruptFails?: Error;
}

export const scriptedQuery = (
	params: {readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options},
	opening: ReadonlyArray<SDKMessage>,
	behaviour: ScriptedBehaviour = {},
): ScriptedQuery => {
	const buffered: Array<SDKMessage> = behaviour.deferOpening === true ? [] : [...opening];
	let waiting: ((message: SDKMessage | null) => void) | null = null;
	let stopped = false;
	let thrown: {readonly cause: unknown} | null = null;

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
		efforts: [],
		contextReads: [],
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
			if (thrown !== null) throw thrown.cause;
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
			if (behaviour.interruptFails !== undefined) throw behaviour.interruptFails;
			return undefined;
		},
		setPermissionMode: async (mode: PermissionMode) => {
			record.modes.push(mode);
		},
		setModel: async (model?: string) => {
			record.models.push(model);
			if (behaviour.modelSwitchFails !== undefined) throw behaviour.modelSwitchFails;
		},
		applyFlagSettings: async (settings: {effortLevel: EffortLevel | null}) => {
			record.efforts.push(settings.effortLevel);
			if (behaviour.effortSwitchFails !== undefined) throw behaviour.effortSwitchFails;
		},
		getContextUsage: async (options: {detail: "summary"}) => {
			record.contextReads.push(options);
			if (behaviour.contextFails !== undefined) throw behaviour.contextFails;
			return {model: behaviour.runningModel ?? params.options.model ?? ""};
		},
		supportedModels: async () => {
			if (behaviour.catalogFails !== undefined) throw behaviour.catalogFails;
			return behaviour.models ?? [];
		},
		supportedCommands: async () => {
			if (behaviour.commandsFail !== undefined) throw behaviour.commandsFail;
			return behaviour.commands ?? [];
		},
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
		fail: (cause: unknown) => {
			thrown = {cause};
			stopped = true;
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
	/**
	 * The `listSessions` calls, in order, each holding the options it was given. An `undefined`
	 * entry is the layer passing none, which is what leaves `includeProgrammatic` at its default.
	 */
	readonly lists: Array<ListSessionsOptions | undefined>;
}

export interface ScriptedSdkOptions extends ScriptedBehaviour {
	/** The messages a fresh `query()` puts on its stream, in order. */
	readonly opening: ReadonlyArray<SDKMessage>;
	/** What `getSessionMessages` answers. Absent answers an empty session, which is the resume miss. */
	readonly rows?: ReadonlyArray<SessionMessage>;
	/** A read that throws instead of answering. */
	readonly readFails?: Error;
	/**
	 * A `query()` that throws rather than handing back a session — the SDK's own arm for a CLI it
	 * could not spawn, which is where its `errorClass` stamps arrive (#8010).
	 */
	readonly openFails?: Error;
	/**
	 * Which open, counting from one, `openFails` throws on; absent, every open throws it. A run that
	 * opens, tears down and then fails to reopen is the only way to reach the layer's between-sessions
	 * state, and it needs the second open alone to fail.
	 */
	readonly openFailsAt?: number;
	/** What `listSessions` answers. Absent is a store holding none, which is a truthful empty list. */
	readonly sessions?: ReadonlyArray<SDKSessionInfo>;
	/** A listing that throws — a store that would not open, not a store with nothing in it. */
	readonly listFails?: Error;
	readonly version?: string;
}

export const scriptedSdk = (options: ScriptedSdkOptions): ScriptedSdk => {
	const opened: Array<ScriptedQuery> = [];
	const reads: Array<{sessionId: string; dir: string | undefined}> = [];
	const lists: Array<ListSessionsOptions | undefined> = [];
	let opens = 0;
	return {
		opened,
		reads,
		lists,
		sdk: {
			version: options.version ?? "0.0.0-scripted",
			query: (params) => {
				opens += 1;
				if (options.openFails !== undefined && (options.openFailsAt ?? opens) === opens) {
					throw options.openFails;
				}
				const query = scriptedQuery(params, options.opening, options);
				opened.push(query);
				return query;
			},
			getSessionMessages: async (sessionId, read) => {
				reads.push({sessionId, dir: read.dir});
				if (options.readFails !== undefined) throw options.readFails;
				return options.rows ?? [];
			},
			listSessions: async (list) => {
				lists.push(list);
				if (options.listFails !== undefined) throw options.listFails;
				return options.sessions ?? [];
			},
		},
	};
};
