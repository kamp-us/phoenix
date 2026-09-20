/**
 * The three port kinds a program author declares — `port.in` (tell me), `port.out` (I announce)
 * and `port.request` (ask me and I answer you specifically) — each over an Effect `Schema`, plus
 * the compiler that turns them into the registry row's port records (`../registry/program.ts`).
 *
 * A declared port carries no version of its own (#8716 R13.1): the row's `kind` is derived from
 * the program id and the port name, compatibility is structural — does the payload fit the
 * schema — and the only version is the npm package's. Nothing here may grow a `@`-segment back.
 */

import {Schema} from "effect";
import type {InPort, OutPort, PortBound, PortSchema, ProgramId} from "../registry/program.ts";

/**
 * What a port may be declared over: a schema whose decode needs no services and whose encoded
 * form is its decoded form. Both halves are load-bearing — the row's `accepts` is a synchronous
 * total predicate over the raw wire payload, so a schema that wanted a service to decode, or that
 * transformed the payload into something else, could not be answered by one.
 */
export type PortCodec<T> = Schema.Codec<T, T, never, unknown>;

/** An arrival the author is told about: a queue of its own, so a bound is owed (#7371). */
export interface InPortDecl<T> {
	readonly direction: "in";
	readonly schema: PortCodec<T>;
	readonly bound: PortBound;
}

/** Something the author announces. Routes leave from it and it owns no queue, so it has no bound. */
export interface OutPortDecl<T> {
	readonly direction: "out";
	readonly schema: PortCodec<T>;
}

/**
 * The Erlang `call` / Akka `ask` shape: a caller asks on this port and gets an answer addressed to
 * it. From the declaring program's side the arrival is an in-port, which is what it compiles to —
 * carrying its output schema as the row port's `answers`, the predicate the kernel runs over the
 * callee's answer before it reaches the caller.
 */
export interface RequestPortDecl<In, Out> {
	readonly direction: "request";
	readonly input: PortCodec<In>;
	readonly output: PortCodec<Out>;
	readonly bound: PortBound;
}

export type AnyPortDecl = InPortDecl<any> | OutPortDecl<any> | RequestPortDecl<any, any>;

export type PortDecls = Readonly<Record<string, AnyPortDecl>>;

/** The payload that arrives on a port, as the author's own type — what `update` is handed. */
export type PortPayload<D> =
	D extends OutPortDecl<infer T>
		? T
		: D extends InPortDecl<infer T>
			? T
			: D extends RequestPortDecl<infer In, any>
				? In
				: never;

/** What a request port answers with; `never` for the two one-way kinds. */
export type PortReply<D> = D extends RequestPortDecl<any, infer Out> ? Out : never;

export type CompiledPort<D> = D extends OutPortDecl<infer T> ? OutPort<T> : InPort<PortPayload<D>>;

export type CompiledPorts<D extends PortDecls> = {readonly [K in keyof D]: CompiledPort<D[K]>};

/**
 * The bound an in-port takes when its author states none: bounded, because nothing may open an
 * unbounded queue by default (#7371), and `suspend` because a default that silently drops a
 * payload is a default nobody would have chosen.
 */
export const DEFAULT_PORT_BOUND: PortBound = {capacity: 16, overflow: "suspend"};

export interface InPortOptions {
	readonly bound?: PortBound;
}

/**
 * The row's `kind` for one declared port. The program id is the whole namespace and the port name
 * is the rest; there is no version segment, and this is the one place a kind is spelled.
 */
export const portKind = (program: ProgramId, name: string): string => `${program}/${name}`;

/** The schema's own check, read as the row's predicate. Built once per port, not per payload. */
const admits = <T>(schema: PortCodec<T>): ((payload: unknown) => payload is T) => Schema.is(schema);

const declareIn = <T>(schema: PortCodec<T>, options?: InPortOptions): InPortDecl<T> => ({
	direction: "in",
	schema,
	bound: options?.bound ?? DEFAULT_PORT_BOUND,
});

const declareOut = <T>(schema: PortCodec<T>): OutPortDecl<T> => ({direction: "out", schema});

const declareRequest = <In, Out>(
	input: PortCodec<In>,
	output: PortCodec<Out>,
	options?: InPortOptions,
): RequestPortDecl<In, Out> => ({
	direction: "request",
	input,
	output,
	bound: options?.bound ?? DEFAULT_PORT_BOUND,
});

/** The author's vocabulary. `in` is a reserved word, so the three kinds live under one export. */
export const port = {in: declareIn, out: declareOut, request: declareRequest} as const;

export const compilePort = <D extends AnyPortDecl>(
	program: ProgramId,
	name: string,
	decl: D,
): CompiledPort<D> => {
	const kind = portKind(program, name);
	const compiled: PortSchema =
		decl.direction === "out"
			? {kind, direction: "out", accepts: admits(decl.schema), schema: decl.schema}
			: decl.direction === "in"
				? {
						kind,
						direction: "in",
						accepts: admits(decl.schema),
						bound: decl.bound,
						schema: decl.schema,
					}
				: {
						kind,
						direction: "in",
						accepts: admits(decl.input),
						bound: decl.bound,
						// A request arrives as its input, so that is the schema the row publishes — what a
						// `Program.shape` reading this row compares on the in side (#8887, #8770).
						schema: decl.input,
						// The output schema is kept, not dropped: it is the only check an answer's shape
						// gets, and the kernel runs it where the answer is handed back (#8756).
						answers: admits(decl.output),
					};
	return compiled as CompiledPort<D>;
};

/** Every declared port as the row carries them, keyed by the name the author gave each one. */
export const compilePorts = <D extends PortDecls>(program: ProgramId, decls: D): CompiledPorts<D> =>
	Object.fromEntries(
		Object.entries(decls).map(([name, decl]) => [name, compilePort(program, name, decl)]),
	) as CompiledPorts<D>;
