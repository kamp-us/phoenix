/**
 * `args` — what the config hands a process, and the one mechanism it rides on.
 *
 * Underneath, an arg **is** Effect's R channel and nothing beside it (#8716 R15.1): each declared
 * arg becomes one `Context.Service` key, and the config call builds one `Layer` providing them all,
 * which the row's handlers then read through their existing `R`. There is no arg store, no
 * registry of filled values and no second lookup path — a parallel injection system beside the R
 * channel is the ruled rabbit-hole.
 *
 * An arg is declared either by a payload schema (`Schema.String`) or, when the thing being handed
 * over is another program, by `Program.shape({in, out})` (`./shape.ts`). A shaped ref doubles as
 * the `Spawnable` the effect vocabulary takes, so an author writes
 * `spawn(args.reviewer, {on: {result: "result"}})` and the checker refuses an out-port the shape
 * does not declare — with no import of the filled program's package anywhere.
 *
 * **A shaped ref's `programId` is the arg's own service key, and that key is what resolves it.**
 * Nothing else mints one, so `isArgKey` tells an arg apart from a program id by sight, and
 * `resolveSpawnTarget` reads the arg back out of the handler's own `R` — the `Layer` the config
 * call built — and answers the id of the program that filled it (#8762). A literal program id
 * resolves to itself, so a shaped arg and a shipped program take one path into the registry.
 *
 * **What the substrate still owes.** A config filling a program-valued arg has to hand something
 * publishing its own port declarations, and a shipped program row publishes payload predicates
 * instead — so the worked example's config cannot yet fill its `reviewer` with the session row it
 * names (#8887). `defineProgram`'s `fill` is typed as a plain record rather than off the
 * declarations its `args` were built from (#8954).
 */

import {Context, Effect, Layer, Option, Result, Schema} from "effect";
import type {Spawnable} from "./effect.ts";
import type {PortCodec} from "./port.ts";
import {
	type AnyProgramShape,
	fitsShape,
	isProgramShape,
	type ShapeMismatch,
	type ShapeOutNames,
	type ShapeSource,
} from "./shape.ts";

/**
 * A `spawn` named an arg its registration never filled with a program — either the config handed
 * that arg nothing, or it handed something carrying no id. Loud rather than a spawn against the
 * arg key, which is the lookup the registry can only answer with "no such program" (#8762).
 */
export class ArgUnfilled extends Schema.TaggedError<ArgUnfilled>()("tuval/authoring/ArgUnfilled", {
	arg: Schema.String,
}) {
	override get message(): string {
		return `arg "${this.arg}" was filled with no program, so a spawn on it names none`;
	}
}

/** What an arg may be declared as: a payload schema, or another program named by its ports. */
export type ArgDecl = PortCodec<any> | AnyProgramShape;

export type ArgDecls = Readonly<Record<string, ArgDecl>>;

/**
 * The service identity of one arg. Structural and per program-and-name, so two programs declaring
 * an arg of the same shape ask for two different services rather than colliding in one `R`.
 */
export interface ArgIdentity<Program extends string, Name extends string> {
	readonly kind: "tuval/authoring/Arg";
	readonly program: Program;
	readonly arg: Name;
}

/** What the config must hand for one declared arg, and what a handler reads back for it. */
export type ArgValue<D> = D extends AnyProgramShape
	? ShapeSource
	: D extends PortCodec<infer T>
		? T
		: never;

export type ArgValues<D extends ArgDecls> = {readonly [K in keyof D]: ArgValue<D[K]>};

/** An arg declared by a schema: the Tag, and the schema it was declared over. */
export interface ValueArgRef<Id extends string, Name extends string, T> {
	readonly name: Name;
	readonly decl: PortCodec<T>;
	readonly key: Context.Service<ArgIdentity<Id, Name>, T>;
}

/**
 * An arg declared by a program shape. It **is** a `Spawnable` of the shape's out-ports, which is
 * what types `spawn(args.reviewer, {on: {…}})` at the use site; `programId` is the arg's service
 * key, since which program fills it is not known until the config call. That key is what the spawn
 * handler resolves the arg through — it reads the filled `ShapeSource` back out of `R` under this
 * exact string and asks the registry for *its* id, so the key never reaches a lookup (#8762).
 */
export interface ProgramArgRef<Id extends string, Name extends string, S extends AnyProgramShape>
	extends Spawnable<ShapeOutNames<S>> {
	readonly name: Name;
	readonly shape: S;
	readonly key: Context.Service<ArgIdentity<Id, Name>, ShapeSource>;
}

export type ArgRef<Id extends string, Name extends string, D> = D extends AnyProgramShape
	? ProgramArgRef<Id, Name, D>
	: D extends PortCodec<infer T>
		? ValueArgRef<Id, Name, T>
		: never;

export type ArgRefs<Id extends string, D extends ArgDecls> = {
	readonly [K in keyof D & string]: ArgRef<Id, K, D[K]>;
};

/** Every arg ref with its declaring program erased — what the compiler and the config take. */
export type AnyArgRef = ValueArgRef<any, any, any> | ProgramArgRef<any, any, any>;

export type AnyArgRefs = Readonly<Record<string, AnyArgRef>>;

/** The services one program's args ask for, as its handlers' `R` carries them. */
export type ArgServices<Id extends string, D extends ArgDecls> = {
	[K in keyof D & string]: ArgIdentity<Id, K>;
}[keyof D & string];

/** The one namespace an arg's service key lives in, which is what makes an arg key recognisable. */
const ARG_KEY_PREFIX = "tuval/arg/";

/** The service key one arg is read through. The program id is the namespace; there is no version. */
export const argKey = (program: string, name: string): string =>
	`${ARG_KEY_PREFIX}${program}/${name}`;

/**
 * Is this string an arg's service key rather than a program id? `argKey` is the only thing that
 * mints one, and a registered program id is an author's own word (`counter`, `codex-session`), so
 * the namespace is the whole test — no registry read and no second lookup path.
 */
export const isArgKey = (program: string): boolean => program.startsWith(ARG_KEY_PREFIX);

/**
 * Declare one program's args. The refs it answers are what the author writes against — `args.model`
 * in a handler, `args.reviewer` in a `spawn` — and what `defineProgram`'s `args` key takes.
 */
export const programArgs = <Id extends string, D extends ArgDecls>(
	program: Id,
	decls: D,
): ArgRefs<Id, D> =>
	Object.fromEntries(
		Object.entries(decls).map(([name, decl]) => {
			const key = Context.Service<any, any>(argKey(program, name));
			return [
				name,
				isProgramShape(decl)
					? {name, shape: decl, key, programId: argKey(program, name), out: decl.out}
					: {name, decl, key},
			];
		}),
		// Every entry was built at the ref shape its own declaration selects; iterating the record
		// erases that correspondence, which is what this cast buys back.
	) as ArgRefs<Id, D>;

/** What the row publishes: arg name to the service key its value is read through. */
export const argKeys = (refs: AnyArgRefs): Readonly<Record<string, string>> =>
	Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ref.key.key]));

const isProgramArgRef = (ref: AnyArgRef): ref is ProgramArgRef<any, any, AnyProgramShape> =>
	"shape" in ref;

/**
 * Fill a program's args into the `Context` its handlers read them back out of. A program-valued
 * arg is checked structurally against its declared shape here and refused with the port that did
 * not fit; everything that passes lands under its own service key.
 */
export const argContext = <Id extends string, D extends ArgDecls>(
	refs: ArgRefs<Id, D>,
	values: ArgValues<D>,
): Result.Result<Context.Context<ArgServices<Id, D>>, ShapeMismatch> => {
	let context = Context.empty();
	for (const [name, ref] of Object.entries(refs as AnyArgRefs)) {
		const value = (values as Readonly<Record<string, unknown>>)[name];
		if (isProgramArgRef(ref)) {
			const source = value as ShapeSource;
			const fit = fitsShape(ref.shape, source, {arg: name, program: source.id});
			if (Result.isFailure(fit)) return Result.fail(fit.failure);
		}
		context = Context.add(context, ref.key, value as never);
	}
	return Result.succeed(context as Context.Context<ArgServices<Id, D>>);
};

/**
 * Fill a program's args, where the config does it: the same check, answered as the `Layer` a
 * handler's `R` is satisfied by. That `Layer` is the whole of how a filled arg reaches a handler.
 */
export const fillArgs = <Id extends string, D extends ArgDecls>(
	refs: ArgRefs<Id, D>,
	values: ArgValues<D>,
): Result.Result<Layer.Layer<ArgServices<Id, D>>, ShapeMismatch> =>
	Result.map(argContext(refs, values), Layer.succeedContext);

/**
 * What a `spawn` actually names. A literal program id is answered untouched, so a shipped program
 * and a shaped arg reach the registry down one path; an arg key is read back out of the ambient
 * `R` — where the row's fill put the `ShapeSource` the config chose — and answers that program's
 * own id. The key is minted from the string rather than held on the effect because `SpawnEffect`
 * is a plain serialisable record and carries no Tag (`./effect.ts`); `Context` is keyed by exactly
 * this string, so the two mintings are the same service.
 */
export const resolveSpawnTarget = (program: string): Effect.Effect<string, ArgUnfilled> =>
	isArgKey(program)
		? Effect.flatMap(Effect.context<never>(), (ambient) => {
				const filled = Context.getOption(
					ambient,
					Context.Service<never, ShapeSource>(program),
				) as Option.Option<ShapeSource>;
				return Option.isSome(filled) && typeof filled.value?.id === "string"
					? Effect.succeed(filled.value.id)
					: Effect.fail(new ArgUnfilled({arg: program}));
			})
		: Effect.succeed(program);
