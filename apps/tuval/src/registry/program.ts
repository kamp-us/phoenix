/**
 * The program row: the one registry entry that describes a program (#7484 R1.1). Everything a
 * program is lives on this row; there is no second species and no view-only exemption. This slice
 * describes a program and never runs one, so it imports nothing from the host slice.
 */

import type {Cmd, Machine, Sub} from "@demlik/tea";
import {type Effect, Schema, type Scope} from "effect";
// Type-only, so the commands slice's runtime dependency on this file stays one-directional.
import type {AnySpell} from "../commands/spell.ts";
import type {SubFailurePolicy} from "../sub-failure.ts";

// Type-only brand: a plain string at runtime, a distinct type to the checker (`.patterns/effect-schema-validation.md`).
export const ProgramId = Schema.String.pipe(Schema.brand("tuval/ProgramId"));
export type ProgramId = typeof ProgramId.Type;

/**
 * A public port: a nominal runtime kind plus a payload predicate, the shape spike #7379 routed on.
 * Not a schema system — the kind names the protocol, the predicate admits a payload. Only an
 * in-port owns a queue, so only an in-port declares the bound (#7371: no unbounded queue by
 * default); an out-port is a name routes leave from. The routing itself is `src/ports/`.
 */
export type PortSchema<T = unknown> = InPort<T> | OutPort<T>;

export interface InPort<T = unknown> {
	readonly kind: string;
	readonly direction: "in";
	readonly accepts: (payload: unknown) => payload is T;
	readonly bound: PortBound;
	/**
	 * The predicate an answer to this port must fit, present only on a port that answers its caller
	 * — `port.request(In, Out)` in the authoring layer (#8716 R17.1). A request port arrives like any
	 * other in-port, so it is one field here rather than a fourth `PortSchema` member every
	 * `direction === "in"` reader would have to learn; its absence is what "this port answers
	 * nothing" means, and an `ask` against such a port is refused (#8756).
	 */
	readonly answers?: (payload: unknown) => boolean;
}

export interface OutPort<T = unknown> {
	readonly kind: string;
	readonly direction: "out";
	readonly accepts: (payload: unknown) => payload is T;
}

/**
 * The queue behind an in-port: `capacity` messages, then `overflow` — Effect's own queue
 * strategies, so a bound is exactly the `Queue.make` option it becomes (`effect/Queue`, rc.112).
 */
export interface PortBound {
	readonly capacity: number;
	readonly overflow: "suspend" | "dropping" | "sliding";
}

/**
 * Host handlers are Effects keyed by Cmd type. The host slice runs them; this row only types them.
 * A handler yields the follow-up messages for its Cmd, and its error and service requirements
 * ride the row's `E` and `R` so a process's needs are inferred from its program.
 */
export type HostHandlers<M extends {readonly type: string}, C extends Cmd, E, R> = {
	readonly [K in C["type"]]: (
		cmd: Extract<C, {readonly type: K}>,
	) => Effect.Effect<ReadonlyArray<M>, E, R>;
};

/**
 * A Sub is long-lived scoped work, so its handler is an Effect the host forks into a Scope of the
 * Sub's own and pushes Msgs from through `dispatch` — a stream has many answers over time, which
 * is the whole difference from a Cmd handler's one list of follow-ups. It lives on the row beside
 * `handlers` rather than on the core machine because a Sub that needs a service has nowhere to ask
 * for one on Demlik's Promise-shaped `subscribe`: the core stays plain data, the Effect stays here.
 */
export type HostSubs<M, U extends Sub, E, R> = {
	readonly [K in U["type"]]: (
		sub: Extract<U, {readonly type: K}>,
		dispatch: (msg: M) => void,
	) => Effect.Effect<void, E, R | Scope.Scope>;
};

/**
 * `never` so a program types its receiver at the port's payload (`(count: number) => Msg`); the
 * wiring ran the port's `accepts` before enqueueing, so whatever it is called with passed it.
 */
export type Receiver<M> = (payload: never) => M;

export type RendererKind = "host-native" | "host-declarative" | "isolated-frame" | "module";

/**
 * A reference only. Rendering is not this epic's; the kernel stores the reference and reports it.
 *
 * For every kind but one, `ref` is a name the page's own table answers to. For `kind: "module"`,
 * `ref` is a module specifier the page loads (ADR 0359): a bare package entry such as
 * `@csirin/tuval-calc/window`, resolved from the app root the way any import there is. The module's
 * `default` export is the renderer, minted with `windowRenderer("module", …)`, and its `admits`
 * export is the predicate over the state that renderer reads (ADR 0358). A row written by a package
 * installed with `pnpm add` is then whole on its own: the kernel half runs from this row, and the
 * page finds the window half by the same string, with no table edit in the app.
 */
export interface RendererRef {
	readonly kind: RendererKind;
	readonly ref: string;
}

/*
 * The three #7467 records below — DefinitionIdentity, CapabilityRequest, Placement — are INERT
 * DATA, ENFORCED BY NOTHING. The kernel stores and reports them and enforces nothing on them:
 * local program code is fully trusted, there is no sandbox, ever (#7484 R1.1, the Neovim model).
 * They are not a security boundary and must not be read as one. They ride on the row so an
 * isolated tier for remote processes can arrive later without a rewrite (#7484 R1.2).
 */

/** Definition identity: which package, which program in it, which version, which bytes. */
export interface DefinitionIdentity {
	readonly package: string;
	readonly program: string;
	readonly version: string;
	readonly digest: string;
}

export type CapabilityFamily =
	| "filesystem"
	| "network"
	| "process"
	| "model"
	| "github"
	| "process-control";

/** One requested capability. Requested is all it is: nothing grants, checks or denies it. */
export interface CapabilityRequest {
	readonly family: CapabilityFamily;
	readonly detail?: string;
}

/**
 * Where the program is placed. `local` means the Node kernel runs it, and it is the only host
 * anything runs on today; `browser` is named so a transport can refuse it (#7556) rather than skip
 * it silently, and nothing spawns one until the browser tier lands.
 */
export interface Placement {
	readonly host: "local" | "browser";
}

/**
 * The core a row carries: Demlik's `Machine` widened by ADR 0346's Sub-failure policy. The policy's
 * type lives in `src/sub-failure.ts`, owned by neither slice, so a row declaring `subFailure` still
 * imports nothing from the host that reads it.
 */
export type ProgramCore<
	S,
	M extends {readonly type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
> = Machine<S, M, C, U, Ctx> & {readonly subFailure?: SubFailurePolicy<M, U>};

export interface Program<
	S,
	M extends {readonly type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	E,
	R,
> {
	readonly id: ProgramId;
	/** What a surface calls this program. Absent means `identity.program` — read it through `programLabel`. */
	readonly label?: string;
	/** Private: read by the host that runs the program and by no other process. */
	readonly core: ProgramCore<S, M, C, U, Ctx>;
	/** Public: the only thing another process may see of this program. */
	readonly ports: Readonly<Record<string, PortSchema>>;
	/**
	 * Public: the commands this program offers, each registered under `[id, ...spell.path]`
	 * (`src/commands/`). The kernel's own `Registry` never reads them — only the spell registry does.
	 */
	readonly spells?: ReadonlyArray<AnySpell>;
	/**
	 * How a payload admitted on one of this program's in-ports becomes its private Msg, keyed by
	 * port name. The payload crosses the wire as `unknown` and takes a Msg shape only here, so the
	 * private vocabulary stays private. Launch refuses a planned process whose program declares
	 * an in-port with no receiver (`src/launch/`).
	 */
	readonly receive?: Readonly<Record<string, Receiver<M>>>;
	readonly handlers: HostHandlers<M, C, E, R>;
	/** Effect-valued Sub handlers, one per Sub the core subscribes to. A row with none omits it. */
	readonly subs?: HostSubs<M, U, E, R>;
	/**
	 * What a spawner dispatches into a process of this program that came back from a checkpoint.
	 *
	 * Pure and total: a state with nothing to resume answers with an empty list. It exists because
	 * Demlik refuses a rehydrating `init` that emits Cmds (`@demlik/tea` 0.12 `runtime-types.ts`),
	 * so the last step of a restore has to be a Msg someone sends after the spawn — and before this
	 * field the only senders were tests, which left every restored session holding a live id and no
	 * transport (#7877). Both spawners read it: `src/launch/` for a graph node whose checkpoint
	 * existed, and `src/durability/restore.ts` for one the graph does not plan. The kernel never
	 * reads what the Msgs mean.
	 */
	readonly resume?: (state: S) => ReadonlyArray<M>;
	/**
	 * What the kernel dispatches into every live process of this program when the config is re-read
	 * and this row's replacement carries different settings (#7509 ruling 3).
	 *
	 * Read off the row a process is *running under*, and handed the reloaded row of the same id —
	 * so a row that wants to diff its own settings has to publish them on itself, as
	 * `claudeSession` publishes `settings` (`../claude/program.ts`). Pure and total: a row that
	 * applies nothing live answers with an empty list, and the kernel never reads what the Msgs
	 * mean. A row the reloaded config dropped is never asked, so its processes keep running under
	 * the row they were spawned from.
	 */
	readonly configChanged?: (next: AnyProgram) => ReadonlyArray<M>;
	/**
	 * Whether this program could restore the raw checkpoint durability loaded for it — the same
	 * verdict its `init` reaches, asked before `init` runs.
	 *
	 * `false` means the process boots on its own refusal, and durability holds the bytes for it: a
	 * snapshot this refuses is never written over, so it stays on disk to be read and re-refused on
	 * every later boot (`src/durability/Checkpoints.ts`, #8112). Without it the refusal was
	 * one-shot — the state carrying it was saved straight back over the checkpoint it refused, and
	 * the next boot restored that state with no failure on it. A row that omits the field restores
	 * whatever loads, which is every program with no parse of its own.
	 */
	readonly restorable?: (raw: unknown) => boolean;
	/**
	 * Whether a state of this program is worth a checkpoint. The host asks it at every save site,
	 * and `false` writes nothing — so a program streaming a reply answers `false` for every
	 * mid-turn state, pays no disk for the burst, and the state that ends the turn is the flush
	 * (`src/host/actor.ts`, #8170). A state this refuses is one no restore ever reads back, which
	 * is why the skipped write is not owed: a half-written reply must never come back as the reply.
	 *
	 * A row that omits it checkpoints every state, which is every program with nothing in flight.
	 */
	readonly checkpointWorthy?: (state: S) => boolean;
	readonly capabilities: ReadonlyArray<CapabilityRequest>;
	/**
	 * The service keys this program's args are read through, one per arg the author declared, keyed
	 * by the arg's name (#8716 R15.1). Data only: an arg's value never rides the row — it rides the
	 * row's existing `R`, provided by the Layer the config call builds when it fills the args
	 * (`src/authoring/args.ts`). A row whose program declares none omits the field.
	 */
	readonly args?: Readonly<Record<string, string>>;
	/**
	 * The program takes keys the shell forwards from its focused window, as its own `key` Msg. Only
	 * `true` or absent: a row that never asked for keys is never sent one, so a keystroke landing on
	 * a window outside its composer cannot reach a program with no cell for it (#7973). The row
	 * carries the declaration and nothing else, as it does for `renderer` — what a forwarded key
	 * becomes is the program's own Msg, and the shell never reads it.
	 */
	readonly takesKeys?: true;
	readonly renderer?: RendererRef;
	/**
	 * The two desk-level renderers, both optional: what this program shows in the desk inspector,
	 * and the segments it contributes to the middle of the status bar while one of its windows is
	 * focused (#7500 rulings 4 and 5). A row declaring neither is a whole row — most programs draw
	 * only in their window, which is the only surface they own. The shapes these resolve to are
	 * `InspectorRenderer` and `StatusRenderer` (`src/shell/desk/renderer.ts`); this row carries the
	 * reference and nothing else, as it does for the window renderer.
	 */
	readonly inspector?: RendererRef;
	readonly status?: RendererRef;
	readonly identity: DefinitionIdentity;
	readonly placement: Placement;
}

/**
 * A row with its private types erased: what the registry stores and resolves, since one registry
 * holds programs of every shape. The host recovers the concrete types when it runs one.
 */
export type AnyProgram = Program<any, any, any, any, any, any, any>;

/** Does the shell forward a key to a window bound to this program? Declared on the row, or not at all. */
export const takesForwardedKeys = (row: AnyProgram): boolean => row.takesKeys === true;

/** The row's provenance as a refusal names it: `package/program@version (digest)`. */
export const provenanceOf = (row: AnyProgram): string =>
	`${row.identity.package}/${row.identity.program}@${row.identity.version} (${row.identity.digest})`;

/**
 * The human-readable name a program shows under. Optional on the row and defaulted from
 * `identity.program`, so the picker (#7557) can list a row "by id and label" without every author
 * writing one out.
 */
export const programLabel = (row: AnyProgram): string => row.label ?? row.identity.program;
