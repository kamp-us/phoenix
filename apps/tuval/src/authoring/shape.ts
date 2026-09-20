/**
 * `Program.shape({in, out})` — how a program says "hand me something with these ports" without
 * importing the package that has them (#8716 R15.1, and the epic's stated no-go: no program
 * package imports another program package).
 *
 * A shape describes port signatures and nothing else — no id, no version, no behaviour — and the
 * check that a candidate fits one reads payload fit, never a version string (R13.1). Payload fit
 * is decided over the two schemas' generated JSON Schema, canonicalised so neither property order
 * nor the name a package gave its schema decides it: two packages that each wrote
 * `Schema.Struct({pr: Schema.Number})` fit each other whatever their own npm versions say, and
 * whatever either called it.
 *
 * The candidate a config actually holds is a shipped registry row — `claudeSession({…})`, not a
 * record of `port.in(…)` declarations — so both forms are read as a shape here (#8887). A row
 * built by `defineProgram` publishes each port's schema beside the predicate it routes on
 * (`./port.ts`), and that is what makes it comparable at all.
 */

import {Result, Schema} from "effect";
import {payloadFits} from "../registry/payload-fit.ts";
import type {PortSchema} from "../registry/program.ts";
import type {AnyPortDecl, PortCodec} from "./port.ts";

/** One side of a shape: port name to the payload schema that port carries. */
export type PortSignatures = Readonly<Record<string, PortCodec<any>>>;

/**
 * What a program-valued arg is typed by. Only the two port records: a shape that also carried an
 * id or a version would be naming a package, which is the dependency this exists to avoid.
 */
export interface ProgramShape<In extends PortSignatures, Out extends PortSignatures> {
	readonly _tag: "tuval/authoring/ProgramShape";
	readonly in: In;
	readonly out: Out;
}

export type AnyProgramShape = ProgramShape<PortSignatures, PortSignatures>;

/** The out-port names a shape declares — what a `spawn` on a shaped arg may route back. */
export type ShapeOutNames<S> = S extends ProgramShape<any, infer Out> ? keyof Out & string : never;

const shape = <In extends PortSignatures, Out extends PortSignatures>(signatures: {
	readonly in: In;
	readonly out: Out;
}): ProgramShape<In, Out> => ({
	_tag: "tuval/authoring/ProgramShape",
	in: signatures.in,
	out: signatures.out,
});

/** The author's vocabulary for typing a program by its ports. `shape` is all of it today. */
export const Program = {shape} as const;

export const isProgramShape = (value: unknown): value is AnyProgramShape =>
	typeof value === "object" &&
	value !== null &&
	(value as {readonly _tag?: unknown})._tag === "tuval/authoring/ProgramShape";

/** Which half of a shape a mismatch is about. */
export type ShapeSide = "in" | "out";

/**
 * A config filled a program-valued arg with a program whose ports do not fit the declared shape.
 * It names the port and the side, and `reason` says how it did not fit — a refusal that only said
 * "does not fit" would leave the author diffing two schema files by eye.
 */
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()(
	"tuval/authoring/ShapeMismatch",
	{
		arg: Schema.String,
		program: Schema.String,
		port: Schema.String,
		side: Schema.Literals(["in", "out"]),
		reason: Schema.String,
	},
) {
	override get message(): string {
		return `arg "${this.arg}" is filled with program "${this.program}", whose ${this.side}-port "${this.port}" does not fit the declared shape: ${this.reason}`;
	}
}

/**
 * One port of a source, either way a program can publish one: the declaration an author wrote, or
 * the compiled record a registry row carries. Both are read here, because what a config actually
 * has in hand is a shipped row — `claudeSession({…})` answers compiled ports, not declarations
 * (#8887).
 */
export type ShapePort = AnyPortDecl | PortSchema;

/**
 * What a config may hand a program-valued arg: anything publishing its ports, in either form. A
 * compiled port carries a `Schema.is` predicate, which cannot be compared with another predicate;
 * what makes it readable here is the schema `compilePort` keeps beside it (`./port.ts`). A port
 * published without one — a hand-written row's — is invisible to the check and is refused by name
 * rather than passed (#8887).
 */
export interface ShapeSource {
	readonly id: string;
	readonly ports?: Readonly<Record<string, ShapePort>>;
}

/** A compiled port is the one with the kernel's predicate on it; a declaration has no `accepts`. */
const isCompiled = (port: ShapePort): port is PortSchema => "accepts" in port;

/** The in-side schema of a port, or `undefined` for one that does not offer a comparable payload. */
const inSignature = (port: ShapePort): PortCodec<any> | undefined => {
	if (isCompiled(port)) return port.direction === "in" ? port.schema : undefined;
	return port.direction === "in"
		? port.schema
		: port.direction === "request"
			? port.input
			: undefined;
};

const outSignature = (port: ShapePort): PortCodec<any> | undefined => {
	if (isCompiled(port)) return port.direction === "out" ? port.schema : undefined;
	return port.direction === "out" ? port.schema : undefined;
};

/** The port signatures a source publishes, read as a shape so a fit is one shape against another. */
export const shapeOf = (source: ShapeSource): AnyProgramShape => {
	const entries = Object.entries(source.ports ?? {}) as ReadonlyArray<readonly [string, ShapePort]>;
	const side = (read: (port: ShapePort) => PortCodec<any> | undefined): PortSignatures =>
		Object.fromEntries(
			entries.flatMap(([name, port]) => {
				const signature = read(port);
				return signature === undefined ? [] : [[name, signature] as const];
			}),
		);
	return {_tag: "tuval/authoring/ProgramShape", in: side(inSignature), out: side(outSignature)};
};

/**
 * Payload fit is `../registry/payload-fit.ts`'s, re-exported here because a shape check is where it
 * was first spelled and `shape.unit.test.ts` still reads it from this module. It moved because a
 * graph route now asks the same question (ADR 0395, #8923) and the two must not answer differently.
 */
export {payloadFits};

interface FitContext {
	readonly arg: string;
	readonly program: string;
}

const fitSide = (
	declared: PortSignatures,
	offered: AnyProgramShape,
	side: ShapeSide,
	context: FitContext,
	published: ReadonlySet<string>,
): ShapeMismatch | undefined => {
	const own = side === "in" ? offered.in : offered.out;
	const other = side === "in" ? offered.out : offered.in;
	for (const [port, signature] of Object.entries(declared)) {
		const candidate = own[port];
		if (candidate === undefined) {
			// A port the source publishes yet neither side of its shape holds is one with no schema
			// behind it, and saying "no such port" about a port that is right there would send the
			// author looking for a typo instead of at the row (#8887).
			const reason =
				other[port] !== undefined
					? `the program declares "${port}" on its ${side === "in" ? "out" : "in"} side`
					: published.has(port)
						? `the program declares "${port}" but publishes no payload schema for it, so nothing can be compared with it (#8887)`
						: `the program declares no ${side}-port named "${port}"`;
			return new ShapeMismatch({...context, port, side, reason});
		}
		if (!payloadFits(signature, candidate)) {
			return new ShapeMismatch({
				...context,
				port,
				side,
				reason: `the program's "${port}" carries a different payload than the shape declares`,
			});
		}
	}
	return undefined;
};

/**
 * Does this program fit the shape an arg declared? Every port the shape names must be there on the
 * same side carrying the same payload; a port the program has and the shape does not is fine, so a
 * program stays free to offer more than any one caller asked for.
 */
export const fitsShape = (
	shapeDecl: AnyProgramShape,
	source: ShapeSource,
	context: FitContext,
): Result.Result<ShapeSource, ShapeMismatch> => {
	const offered = shapeOf(source);
	const published = new Set(Object.keys(source.ports ?? {}));
	const mismatch =
		fitSide(shapeDecl.in, offered, "in", context, published) ??
		fitSide(shapeDecl.out, offered, "out", context, published);
	return mismatch === undefined ? Result.succeed(source) : Result.fail(mismatch);
};
