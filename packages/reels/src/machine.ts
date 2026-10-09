/**
 * One render batch as a tea machine. Soundtracks are written first, because a Remotion bundle
 * snapshots its public dir; their fan-out joins into the bundle; renders then fan out under a
 * concurrency cap, each retried on a backoff curve; a rendered reel lands in the idempotency
 * ledger under its content hash, so an unchanged reel is never rendered twice.
 */
import {Cmd, defineMachine, type Settled} from "@demlik/tea";
import {createFanOut, type FanOutState} from "@demlik/tea/flow";
import {type IdempotencyStore, initStore, recall, remember} from "@demlik/tea/idempotency";
import {
	nextDelayMs,
	type RetryPolicy,
	type RetryState,
	recordFailure,
	shouldRetry,
} from "@demlik/tea/retry-backoff";
import * as Schema from "effect/Schema";

const standard = Schema.toStandardSchemaV1;

export const soundtrack = Cmd.define("soundtrack", {
	input: standard(Schema.Struct({reelId: Schema.String})),
	ok: standard(Schema.Struct({path: Schema.String})),
	err: ["soundtrack_failed"],
});

export const bundle = Cmd.define("bundle", {
	input: standard(Schema.Struct({reels: Schema.Number})),
	ok: standard(Schema.Struct({serveUrl: Schema.String})),
	err: ["bundle_failed"],
});

export const render = Cmd.define("render", {
	input: standard(Schema.Struct({reelId: Schema.String, attempt: Schema.Int})),
	ok: standard(Schema.Struct({video: Schema.String, seconds: Schema.Number})),
	err: ["render_failed"],
});

export const pause = Cmd.define("pause", {
	input: standard(Schema.Struct({reelId: Schema.String, ms: Schema.Number})),
	ok: standard(Schema.Undefined),
	err: [],
});

export const caption = Cmd.define("caption", {
	input: standard(Schema.Struct({reelId: Schema.String, video: Schema.String})),
	ok: standard(Schema.Struct({path: Schema.String})),
	err: ["caption_failed"],
});

/** A reel the batch was asked for, with the hash of everything its picture depends on. */
export interface Requested {
	readonly id: string;
	readonly hash: string;
}

export type Outcome =
	| {
			readonly status: "rendered";
			readonly video: string;
			readonly seconds: number;
			readonly attempts: number;
	  }
	| {readonly status: "unchanged"; readonly video: string}
	| {readonly status: "failed"; readonly error: string; readonly attempts: number};

export interface Rendered {
	readonly video: string;
}

export type Ledger = IdempotencyStore<Rendered>;

interface Batch {
	readonly requested: ReadonlyArray<Requested>;
	readonly outcomes: Readonly<Record<string, Outcome>>;
	readonly ledger: Ledger;
}

export type State =
	| ({readonly type: "idle"} & Pick<Batch, "ledger">)
	| ({readonly type: "scoring"; readonly voices: FanOutState<string, string>} & Batch)
	| ({readonly type: "bundling"; readonly queue: ReadonlyArray<string>} & Batch)
	| ({
			readonly type: "rendering";
			readonly renders: FanOutState<string, Rendered>;
			readonly retries: Readonly<Record<string, RetryState>>;
	  } & Batch)
	| ({readonly type: "finished"} & Batch);

export type Msg = {
	readonly type: "batch_requested";
	readonly reels: ReadonlyArray<Requested>;
	readonly force: boolean;
	readonly at: number;
};

/** Every Msg the machine folds: the batch request plus each command's settled result. */
export type BatchMsg =
	| Msg
	| Settled<typeof soundtrack | typeof bundle | typeof render | typeof pause | typeof caption>;

export const RETRY: RetryPolicy = {
	baseMs: 2_000,
	factor: 2,
	capMs: 20_000,
	jitter: "none",
	maxAttempts: 3,
};

export const LEDGER_CAPACITY = 1_000;

const errorText = (error: unknown): string =>
	typeof error === "object" && error !== null && "message" in error
		? String(error.message)
		: typeof error === "object" && error !== null && "_tag" in error
			? String(error._tag)
			: String(error);

export const reelsMachine = (options: {readonly concurrency: number}) => {
	const voices = createFanOut<string, string, ReturnType<typeof soundtrack>, never>({
		concurrency: 4,
		idOf: (id) => id,
		of: (id) => soundtrack({reelId: id}),
	});
	const renders = createFanOut<string, Rendered, ReturnType<typeof render>, never>({
		concurrency: options.concurrency,
		idOf: (id) => id,
		of: (id) => render({reelId: id, attempt: 1}),
	});

	type Batched = Extract<State, {requested: unknown}>;
	type Cmds = ReturnType<
		typeof render | typeof soundtrack | typeof bundle | typeof pause | typeof caption
	>;

	const request = (
		state: State,
		msg: Extract<Msg, {type: "batch_requested"}>,
	): readonly [State, ReadonlyArray<Cmds>] => {
		const outcomes: Record<string, Outcome> = {};
		const queue: Array<string> = [];
		for (const reel of msg.reels) {
			const previous = msg.force ? undefined : recall(state.ledger, reel.hash, msg.at);
			if (previous === undefined) queue.push(reel.id);
			else outcomes[reel.id] = {status: "unchanged", video: previous.video};
		}
		const batch = {requested: msg.reels, outcomes, ledger: state.ledger};
		if (queue.length === 0) return [{type: "finished", ...batch}, []];
		const [voiceState, cmds] = voices.scatter(voices.init(), queue);
		return [{type: "scoring", voices: voiceState, ...batch}, cmds];
	};

	/** A fan-out settled its last item: scoring hands its queue to the bundle, rendering finishes. */
	const settleRender = (
		state: Extract<State, {type: "rendering"}>,
		next: readonly [FanOutState<string, Rendered>, ReadonlyArray<Cmds>],
		outcomes: Batched["outcomes"],
		ledger: Ledger,
	): readonly [State, ReadonlyArray<Cmds>] => {
		const [renderState, cmds] = next;
		const settled = renderState.pending.length === 0 && renderState.running.length === 0;
		const common = {requested: state.requested, outcomes, ledger};
		return settled
			? [{type: "finished", ...common}, cmds]
			: [{...state, ...common, renders: renderState}, cmds];
	};

	const hashOf = (state: Batched, id: string): string =>
		state.requested.find((reel) => reel.id === id)?.hash ?? id;

	return defineMachine({
		types: {model: {} as State, msg: {} as Msg},
		cmds: [soundtrack, bundle, render, pause, caption],
		init: (loaded) =>
			loaded !== null
				? [loaded, []]
				: [{type: "idle", ledger: initStore<Rendered>({capacity: LEDGER_CAPACITY})}, []],
		update: {
			idle: {batch_requested: request},
			finished: {batch_requested: request},
			scoring: {
				batch_requested: request,
				soundtrack_ok: (state, msg) => {
					const [voiceState, cmds] = voices.itemOk(state.voices, msg.cmd.reelId, msg.value.path);
					if (voiceState.pending.length > 0 || voiceState.running.length > 0) {
						return [{...state, voices: voiceState}, cmds];
					}
					const queue = voiceState.done.map((done) => done.item);
					const failed = Object.fromEntries(
						voiceState.failed.map((failure): [string, Outcome] => [
							failure.item,
							{status: "failed", error: errorText(failure.error), attempts: 0},
						]),
					);
					const {voices: _, type: __, ...batch} = state;
					return [
						{type: "bundling", queue, ...batch, outcomes: {...state.outcomes, ...failed}},
						[...cmds, bundle({reels: queue.length})],
					];
				},
				soundtrack_err: (state, msg) => {
					const [voiceState, cmds] = voices.itemErr(state.voices, msg.cmd.reelId, msg.error);
					const outcomes = {
						...state.outcomes,
						[msg.cmd.reelId]: {status: "failed", error: errorText(msg.error), attempts: 0} as const,
					};
					if (voiceState.pending.length > 0 || voiceState.running.length > 0) {
						return [{...state, voices: voiceState, outcomes}, cmds];
					}
					const queue = voiceState.done.map((done) => done.item);
					const {voices: _, type: __, ...batch} = state;
					if (queue.length === 0) return [{type: "finished", ...batch, outcomes}, cmds];
					return [
						{type: "bundling", queue, ...batch, outcomes},
						[...cmds, bundle({reels: queue.length})],
					];
				},
			},
			bundling: {
				batch_requested: request,
				bundle_ok: (state) => {
					const [renderState, cmds] = renders.scatter(renders.init(), state.queue);
					const {queue: _, type: __, ...batch} = state;
					return [{type: "rendering", renders: renderState, retries: {}, ...batch}, cmds];
				},
				bundle_err: (state, msg) => {
					const outcomes = {...state.outcomes};
					for (const id of state.queue)
						outcomes[id] = {status: "failed", error: errorText(msg.error), attempts: 0};
					const {queue: _, type: __, ...batch} = state;
					return [{type: "finished", ...batch, outcomes}, []];
				},
			},
			rendering: {
				batch_requested: request,
				render_ok: (state, msg) => {
					const id = msg.cmd.reelId;
					const rendered: Outcome = {
						status: "rendered",
						video: msg.value.video,
						seconds: msg.value.seconds,
						attempts: msg.cmd.attempt,
					};
					return [
						{...state, outcomes: {...state.outcomes, [id]: rendered}},
						[caption({reelId: id, video: msg.value.video})],
					];
				},
				render_err: (state, msg) => {
					const id = msg.cmd.reelId;
					const retry = recordFailure(state.retries[id] ?? {attempt: 0}, msg.error);
					if (shouldRetry(retry, RETRY)) {
						return [
							{...state, retries: {...state.retries, [id]: retry}},
							[pause({reelId: id, ms: nextDelayMs(retry, RETRY)})],
						];
					}
					const outcomes = {
						...state.outcomes,
						[id]: {status: "failed", error: errorText(msg.error), attempts: retry.attempt} as const,
					};
					return settleRender(
						state,
						renders.itemErr(state.renders, id, msg.error),
						outcomes,
						state.ledger,
					);
				},
				pause_ok: (state, msg) => {
					const id = msg.cmd.reelId;
					return [state, [render({reelId: id, attempt: (state.retries[id]?.attempt ?? 0) + 1})]];
				},
				pause_err: (state) => [state, []],
				caption_ok: (state, msg) => {
					const id = msg.cmd.reelId;
					const ledger = remember(state.ledger, hashOf(state, id), {video: msg.cmd.video}, msg.at);
					return settleRender(
						state,
						renders.itemOk(state.renders, id, {video: msg.cmd.video}),
						state.outcomes,
						ledger,
					);
				},
				caption_err: (state, msg) => {
					const id = msg.cmd.reelId;
					const outcomes = {
						...state.outcomes,
						[id]: {status: "failed", error: errorText(msg.error), attempts: 1} as const,
					};
					return settleRender(
						state,
						renders.itemErr(state.renders, id, msg.error),
						outcomes,
						state.ledger,
					);
				},
			},
		},
	});
};

export type ReelsMachine = ReturnType<typeof reelsMachine>;

export const isFinished = (state: State): boolean => state.type === "finished";
