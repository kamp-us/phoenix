/**
 * The program row: the one registry entry that describes a program (#7484 R1.1). Everything a
 * program is lives on this row; there is no second species and no view-only exemption. This slice
 * describes a program and never runs one, so it imports nothing from the host slice.
 */

import type {Cmd, Machine, Sub} from "@demlik/tea";
import {type Effect, Schema, type Scope} from "effect";
// Type-only, so the commands slice's runtime dependency on this file stays one-directional.
import type {AnySpell} from "../commands/spell.ts";

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

export type RendererKind = "host-native" | "host-declarative" | "isolated-frame";

/** A reference only. Rendering is not this epic's; the kernel stores the reference and reports it. */
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

/** Where the program is placed. `local` is the only host today; the host chooses placement. */
export interface Placement {
	readonly host: "local";
}

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
	/** Private: read by the host that runs the program and by no other process. */
	readonly core: Machine<S, M, C, U, Ctx>;
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
	readonly capabilities: ReadonlyArray<CapabilityRequest>;
	readonly renderer?: RendererRef;
	readonly identity: DefinitionIdentity;
	readonly placement: Placement;
}

/**
 * A row with its private types erased: what the registry stores and resolves, since one registry
 * holds programs of every shape. The host recovers the concrete types when it runs one.
 */
export type AnyProgram = Program<any, any, any, any, any, any, any>;

/** The row's provenance as a refusal names it: `package/program@version (digest)`. */
export const provenanceOf = (row: AnyProgram): string =>
	`${row.identity.package}/${row.identity.program}@${row.identity.version} (${row.identity.digest})`;
