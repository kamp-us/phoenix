/**
 * `KernelBridge`: `spawn`, `send` and `read` as Effects, over the kernel's own `process` spells.
 *
 * It is an adapter over `SpellBridge` and nothing more — the founder's walk on #7642 ruled that a
 * second agent program costs an adapter and no new spell, and `bridge/SpellBridge.ts` names this
 * file as that adapter. Going through the bridge is also what keeps the calling program's
 * allowlist between an agent and the registry: a path the row did not allow is refused before the
 * executor is reached (`.patterns/tuval-spells.md`, "The bridge").
 *
 * Nothing here names a program. The one process the bridge speaks for is the caller's own, and the
 * caller is named by the `Scope` the layer is built with — the executor re-resolves the process
 * from that scope's window, so a spawn is a child of the calling process and nothing on the wire
 * can claim otherwise (#7617 R2.2).
 *
 * The three answers are decoded against the spells' own result shapes. A reply that does not decode
 * is the kernel answering off its own `result` schema, which is not something a caller can act on,
 * so it dies — the same call the executor makes for a `BadResult` (`.patterns/tuval-spells.md`).
 */

import {Context, Effect, Layer, Option, Schema} from "effect";
import type {SpellNotAllowed} from "../../commands/bridge/index.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";
import type {Scope, SpellPath} from "../../commands/spell.ts";
import {ProcessId} from "../../process/process.ts";
import type {SpellFailure} from "../../protocol/messages.ts";
import type {ProgramId} from "../../registry/program.ts";
import {PortRefused, UnknownPort, UnknownProcess, UnknownProgram} from "./errors.ts";

const SPAWN: SpellPath = ["process", "spawn"];
const SEND: SpellPath = ["process", "send"];
const READ: SpellPath = ["process", "read"];

/**
 * The `_tag`s of the four errors `core/process.ts` raises, as the executor puts them on the wire.
 * `Schema.TaggedError` carries no static tag, so they are written out here and pinned against the
 * real classes in `bridge.unit.test.ts` — a renamed kernel tag reddens there, not in production.
 */
const KERNEL_TAGS = {
	unknownProgram: "tuval/commands/UnknownProgram",
	unknownProcess: "tuval/commands/UnknownProcess",
	unknownPort: "tuval/commands/UnknownPort",
	portRefused: "tuval/commands/PortRefused",
} as const;

const Spawned = Schema.Struct({process: ProcessId});
const Sent = Schema.Struct({delivered: Schema.Boolean});
const Read = Schema.Union([
	Schema.Struct({empty: Schema.Literal(true)}),
	Schema.Struct({empty: Schema.Literal(false), value: Schema.Unknown}),
]);

/**
 * A scripted process: what `send` checks a payload against, and what `read` hands back, in order.
 * `kind` is only ever read back out of a `PortRefused`, which is how a caller learns what a port
 * takes.
 */
export interface ScriptedProcess {
	readonly program: string;
	readonly inPorts: Readonly<
		Record<string, {readonly kind: string; readonly accepts: (payload: unknown) => boolean}>
	>;
	/** `read` answers these in order and then answers none; it never replays. */
	readonly outPorts: Readonly<Record<string, ReadonlyArray<unknown>>>;
}

/** Keyed by the process id `spawn` hands back, in insertion order: one entry is one spawn. */
export type ScriptedKernel = Readonly<Record<string, ScriptedProcess>>;

export class KernelBridge extends Context.Service<
	KernelBridge,
	{
		readonly spawn: (program: ProgramId) => Effect.Effect<ProcessId, UnknownProgram>;
		/** `false` only under a `dropping` in-port bound: the queue was full and refused the payload. */
		readonly send: (
			process: ProcessId,
			port: string,
			payload: unknown,
		) => Effect.Effect<boolean, UnknownProcess | UnknownPort | PortRefused>;
		readonly read: (
			process: ProcessId,
			port: string,
		) => Effect.Effect<Option.Option<unknown>, UnknownProcess | UnknownPort>;
	}
>()("tuval/KernelBridge") {
	/**
	 * The bridge as the calling process sees it. `scope` is the caller's own — the window it runs
	 * in, its workspace and its client — and every call carries it, so the kernel resolves the
	 * parent rather than trusting an id.
	 */
	static readonly live = (scope: Scope): Layer.Layer<KernelBridge, never, SpellBridge> =>
		Layer.effect(KernelBridge, make(scope));

	/**
	 * The deterministic fake a caller's own tests drive. It reaches no kernel and spawns nothing.
	 * Each build gets its own state, so one table drives many tests and a spawn in one is not spent
	 * in the next.
	 */
	static readonly scripted = (table: ScriptedKernel): Layer.Layer<KernelBridge> =>
		Layer.effect(
			KernelBridge,
			Effect.sync(() => buildScripted(table)),
		);
}

/**
 * A failure outside the four. `BadArgs`, `UnknownSpell`, `NoSuchWindow` and `SpellNotAllowed` all
 * say the row that mounted this bridge wired it wrong — a caller can do nothing with any of them,
 * so the fiber dies rather than the agent being handed a refusal it cannot act on.
 */
const unexpected = (path: SpellPath, failure: SpellFailure) =>
	Effect.die(`${path.join(".")} answered "${failure.tag}": ${failure.message}`);

const make = Effect.fn("Tuval.KernelBridge.make")(function* (scope: Scope) {
	const bridge = yield* SpellBridge;

	/** One spell call, its reply decoded, its failure re-read as one of this bridge's four. */
	const call = <A extends Schema.Top, E>(
		path: SpellPath,
		args: Readonly<Record<string, unknown>>,
		result: A,
		lift: (failure: SpellFailure) => Effect.Effect<never, E>,
	): Effect.Effect<A["Type"], E, A["DecodingServices"]> =>
		bridge.call(path, args, scope).pipe(
			Effect.catch((error: SpellFailure | SpellNotAllowed) =>
				"_tag" in error ? Effect.die(error) : lift(error),
			),
			Effect.flatMap((reply) => Schema.decodeUnknownEffect(result)(reply).pipe(Effect.orDie)),
		);

	const spawn = Effect.fn("Tuval.KernelBridge.spawn")(function* (program: ProgramId) {
		const answer = yield* call(SPAWN, {program}, Spawned, (failure) =>
			failure.tag === KERNEL_TAGS.unknownProgram
				? Effect.fail(new UnknownProgram({program, detail: failure.message}))
				: unexpected(SPAWN, failure),
		);
		return answer.process;
	});

	const send = Effect.fn("Tuval.KernelBridge.send")(function* (
		process: ProcessId,
		port: string,
		payload: unknown,
	) {
		const lift = (
			failure: SpellFailure,
		): Effect.Effect<never, UnknownProcess | UnknownPort | PortRefused> =>
			failure.tag === KERNEL_TAGS.portRefused
				? Effect.fail(new PortRefused({process, port, detail: failure.message}))
				: liftPortFailure(SEND, process, port, "in", failure);
		const answer = yield* call(SEND, {process, port, payload}, Sent, lift);
		return answer.delivered;
	});

	const read = Effect.fn("Tuval.KernelBridge.read")(function* (process: ProcessId, port: string) {
		const answer = yield* call(READ, {process, port}, Read, (failure) =>
			liftPortFailure(READ, process, port, "out", failure),
		);
		return answer.empty ? Option.none<unknown>() : Option.some(answer.value);
	});

	return KernelBridge.of({spawn, send, read});
});

/**
 * The two refusals both `send` and `read` can meet. `PortRefused` is `send`'s alone — nothing a
 * read submits can fail a predicate — so it is lifted at that call site and dies here.
 */
const liftPortFailure = (
	path: SpellPath,
	process: ProcessId,
	port: string,
	direction: "in" | "out",
	failure: SpellFailure,
): Effect.Effect<never, UnknownProcess | UnknownPort> => {
	switch (failure.tag) {
		case KERNEL_TAGS.unknownProcess:
			return Effect.fail(new UnknownProcess({process, detail: failure.message}));
		case KERNEL_TAGS.unknownPort:
			return Effect.fail(new UnknownPort({process, port, direction, detail: failure.message}));
		default:
			return unexpected(path, failure);
	}
};

const buildScripted = (table: ScriptedKernel): KernelBridge["Service"] => {
	const rows = Object.entries(table);
	const handed = new Set<string>();
	const drained = new Map<string, number>();

	const rowFor = (process: ProcessId) =>
		Effect.suspend(() => {
			const row = table[process];
			if (row === undefined) {
				return Effect.fail(
					new UnknownProcess({process, detail: "the scripted table holds no such process"}),
				);
			}
			return Effect.succeed(row);
		});

	const spawn = Effect.fn("Tuval.KernelBridge.scripted.spawn")(function* (program: ProgramId) {
		const next = rows.find(([id, row]) => row.program === program && !handed.has(id));
		if (next === undefined) {
			return yield* new UnknownProgram({
				program,
				detail: "the scripted table has no unspawned row for it",
			});
		}
		handed.add(next[0]);
		return ProcessId.make(next[0]);
	});

	const send = Effect.fn("Tuval.KernelBridge.scripted.send")(function* (
		process: ProcessId,
		port: string,
		payload: unknown,
	) {
		const row = yield* rowFor(process);
		const declared = row.inPorts[port];
		if (declared === undefined) {
			return yield* new UnknownPort({
				process,
				port,
				direction: "in",
				detail: "the scripted process declares no such in-port",
			});
		}
		if (!declared.accepts(payload)) {
			return yield* new PortRefused({
				process,
				port,
				detail: `port "${port}" takes ${declared.kind} and refused the payload`,
			});
		}
		return true;
	});

	const read = Effect.fn("Tuval.KernelBridge.scripted.read")(function* (
		process: ProcessId,
		port: string,
	) {
		const row = yield* rowFor(process);
		const scripted = row.outPorts[port];
		if (scripted === undefined) {
			return yield* new UnknownPort({
				process,
				port,
				direction: "out",
				detail: "the scripted process declares no such out-port",
			});
		}
		const key = `${process} ${port}`;
		const taken = drained.get(key) ?? 0;
		if (taken >= scripted.length) return Option.none<unknown>();
		drained.set(key, taken + 1);
		return Option.some(scripted[taken]);
	});

	return KernelBridge.of({spawn, send, read});
};
