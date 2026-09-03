/**
 * The actor definition: a Demlik core machine plus Effect-valued host handlers.
 *
 * The machine (`defineMachine({init, update, subs, identity, subscriptions})`) stays Demlik's:
 * pure data, no Effect in State, Cmd or Sub (#7371). The handlers are where Effect lives — a Cmd
 * handler is one-shot work, a Sub handler is long-lived scoped work — and their error and service
 * requirements are derived onto the definition (`ErrorOf`/`ServicesOf`), the same shape
 * `Effect.all` uses over a record (`All.ReturnObject` in `effect/Effect`, rc.112), so a program's `E`
 * and `R` fall out of its handlers rather than being hand-declared.
 */

import type {
	Cmd,
	CtxArg,
	DepKeyedSub,
	Identity,
	Reducer,
	RuntimeErrorPhase,
	Store,
	Sub,
	Supervision,
	Transitions,
	UpdateForm,
} from "@demlik/tea";
import type {Effect, Scope} from "effect";

/**
 * A Demlik `Machine` minus its Promise-shaped `interpret` and `subscribe` — the pure core plus
 * the dep-keyed Subs and the manual `subscriptions` aggregate. A `defineMachine` result is one;
 * so is a plain literal, since `applyCellChecked` detects the update form when `__form` is absent.
 */
export interface CoreMachine<S, M extends {type: string}, C extends Cmd, U extends Sub, Ctx> {
	readonly init: (loaded: S | null, ctx: Ctx) => readonly [S, readonly C[]];
	readonly update: Reducer<S, M, C> | ([S] extends [{type: string}] ? Transitions<S, M, C> : never);
	readonly subs?: ReadonlyArray<DepKeyedSub<S, M, Ctx>>;
	readonly identity?: Identity<S, M>;
	readonly subscriptions?: (state: S) => readonly U[];
	readonly __form?: UpdateForm;
}

export type Dispatch<M> = (msg: M) => void;

export type CmdHandler<M, C extends Cmd, K extends C["type"], Ctx> = (
	cmd: Extract<C, {type: K}>,
	ctx: Ctx,
	dispatch: Dispatch<M>,
	// biome-ignore lint/suspicious/noConfusingVoidType: a Cmd handler yields a follow-up Msg or nothing; `void` lets a body that returns nothing typecheck
) => Effect.Effect<M | void, any, any>;

export type SubHandler<M, U extends Sub, K extends U["type"], Ctx> = (
	sub: Extract<U, {type: K}>,
	ctx: Ctx,
	dispatch: Dispatch<M>,
) => Effect.Effect<void, any, any>;

export type InterpretHandlers<M, C extends Cmd, Ctx> = {
	readonly [K in C["type"]]: CmdHandler<M, C, K, Ctx>;
};

export type SubscribeHandlers<M, U extends Sub, Ctx> = {
	readonly [K in U["type"]]: SubHandler<M, U, K, Ctx>;
};

export type ErrorOf<H> = {
	[K in keyof H]: H[K] extends (...args: never[]) => Effect.Effect<unknown, infer E, unknown>
		? E
		: never;
}[keyof H];

/** A Sub handler runs under a Scope the host owns, so `Scope` is never a requirement of the actor. */
export type ServicesOf<H> = Exclude<
	{
		[K in keyof H]: H[K] extends (...args: never[]) => Effect.Effect<unknown, unknown, infer R>
			? R
			: never;
	}[keyof H],
	Scope.Scope
>;

export type HostErrorPhase = RuntimeErrorPhase | "sub-fiber";

export interface HostErrorContext {
	readonly phase: HostErrorPhase;
}

/** The sink for a failure that has no caller: a follow-up, a Sub's dispatch, a Sub fiber, teardown. */
export type OnError = (error: unknown, context: HostErrorContext) => Effect.Effect<void>;

export type ActorDefinition<
	S,
	M extends {type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	I extends InterpretHandlers<M, C, Ctx>,
	B extends SubscribeHandlers<M, U, Ctx>,
> = CtxArg<Ctx> & {
	readonly machine: CoreMachine<S, M, C, U, Ctx>;
	readonly interpret: I;
	readonly subscribe: B;
	readonly store?: Store<S>;
	readonly supervision?: Supervision<S, M>;
	readonly onError?: OnError;
};

/**
 * Indexed access, not a conditional: a conditional's fallback constraint is `never`, and TS's
 * union subtype reduction then drops the still-generic yield carrying it from `Effect.gen`'s
 * yield union beside any concrete `Effect<void>` yield, so a built actor's `E` read as `never`.
 */
export type DefinitionError<D extends {readonly interpret: unknown; readonly subscribe: unknown}> =
	| ErrorOf<D["interpret"]>
	| ErrorOf<D["subscribe"]>;

export type DefinitionServices<
	D extends {readonly interpret: unknown; readonly subscribe: unknown},
> = ServicesOf<D["interpret"]> | ServicesOf<D["subscribe"]>;

export const defineActor = <
	S,
	M extends {type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	const I extends InterpretHandlers<M, C, Ctx>,
	const B extends SubscribeHandlers<M, U, Ctx>,
>(
	definition: ActorDefinition<S, M, C, U, Ctx, I, B>,
): ActorDefinition<S, M, C, U, Ctx, I, B> => definition;
