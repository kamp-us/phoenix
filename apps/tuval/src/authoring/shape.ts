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
 */

import {Result, Schema} from "effect";
import type {AnyPortDecl, PortCodec, PortDecls} from "./port.ts";

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
 * What a config may hand a program-valued arg: anything publishing its own port declarations,
 * which is exactly what an author writes (`AuthoredProgram`). The compiled row is not that — it
 * erases each port's schema down to a payload predicate, and a predicate cannot be compared with
 * another predicate.
 */
export interface ShapeSource {
	readonly id: string;
	readonly ports?: PortDecls;
}

/** The in-side schema of a declared port, or `undefined` for a port that does not take one. */
const inSignature = (decl: AnyPortDecl): PortCodec<any> | undefined =>
	decl.direction === "in" ? decl.schema : decl.direction === "request" ? decl.input : undefined;

const outSignature = (decl: AnyPortDecl): PortCodec<any> | undefined =>
	decl.direction === "out" ? decl.schema : undefined;

/** The port signatures a source publishes, read as a shape so a fit is one shape against another. */
export const shapeOf = (source: ShapeSource): AnyProgramShape => {
	const entries = Object.entries(source.ports ?? {}) as ReadonlyArray<
		readonly [string, AnyPortDecl]
	>;
	const side = (read: (decl: AnyPortDecl) => PortCodec<any> | undefined): PortSignatures =>
		Object.fromEntries(
			entries.flatMap(([name, decl]) => {
				const signature = read(decl);
				return signature === undefined ? [] : [[name, signature] as const];
			}),
		);
	return {_tag: "tuval/authoring/ProgramShape", in: side(inSignature), out: side(outSignature)};
};

/**
 * The generator's default reference policy is `({identifier}) => identifier`, which emits any schema
 * carrying an `identifier` annotation as a `$ref` into `$defs` keyed by that name — so the name its
 * package chose would land in the compared string and two identical payloads named differently would
 * not fit. Naming a schema is the ordinary Effect idiom, so that is the common case, not the rare
 * one. Returning `undefined` inlines every named schema instead. A recursive payload still needs a
 * `$def` to point at and gets a synthetic name derived from its own structure, not from the author's
 * annotation, so two recursive payloads of the same shape still compare equal.
 */
const inlineNames = {referencePolicy: () => undefined} as const;

/**
 * A schema's payload as a comparable string: its JSON Schema, with every object's keys sorted, so
 * two structurally identical payloads compare equal however their authors ordered the fields.
 */
const canonical = (schema: PortCodec<any>): string =>
	stable(Schema.toJsonSchemaDocument(schema, inlineNames));

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(unordered(key, (value as Record<string, unknown>)[key]))}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

/**
 * `required` is a set, so the order the author declared their struct's fields in is not part of the
 * payload. Every other array in a JSON Schema is positional (`prefixItems`, `anyOf` branches), and
 * sorting one of those would call two different payloads the same.
 */
const unordered = (key: string, value: unknown): unknown =>
	key === "required" && Array.isArray(value) ? [...(value as ReadonlyArray<string>)].sort() : value;

/** Do two ports carry the same payload? Structural, over the schemas — no version is read. */
export const payloadFits = (declared: PortCodec<any>, offered: PortCodec<any>): boolean =>
	canonical(declared) === canonical(offered);

interface FitContext {
	readonly arg: string;
	readonly program: string;
}

const fitSide = (
	declared: PortSignatures,
	offered: AnyProgramShape,
	side: ShapeSide,
	context: FitContext,
): ShapeMismatch | undefined => {
	const own = side === "in" ? offered.in : offered.out;
	const other = side === "in" ? offered.out : offered.in;
	for (const [port, signature] of Object.entries(declared)) {
		const candidate = own[port];
		if (candidate === undefined) {
			const reason =
				other[port] === undefined
					? `the program declares no ${side}-port named "${port}"`
					: `the program declares "${port}" on its ${side === "in" ? "out" : "in"} side`;
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
	const mismatch =
		fitSide(shapeDecl.in, offered, "in", context) ??
		fitSide(shapeDecl.out, offered, "out", context);
	return mismatch === undefined ? Result.succeed(source) : Result.fail(mismatch);
};
