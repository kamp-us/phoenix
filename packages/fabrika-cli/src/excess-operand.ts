/**
 * Refuse an operand a leaf verb never declared, instead of binding none of them and answering
 * anyway (#4828).
 *
 * At a leaf the Effect CLI parser reports nothing: `resolveFirstValue` gates its `UnknownSubcommand`
 * on `!expectsArgs && subIndex.size > 0`, and a leaf's `subIndex` is empty, so the token becomes a
 * positional; `parseParams` then binds the declared params in order and **returns**, dropping the
 * unconsumed remainder without an error (`effect@4.0.0-beta.92`,
 * `src/unstable/cli/internal/parser.ts` and `internal/command.ts`). Nothing is ever pushed into
 * `parsedArgs.errors`, so this is a *missing* check — not the ordering bug the sibling guard in
 * `unknown-subcommand.ts` works around (#4822), which loses an error that does get produced.
 *
 * The fix declares the remainder rather than re-deriving it. Every leaf gets one hidden trailing
 * catch-all argument, so the **parser** decides what is a flag value and what is a positional — the
 * one thing a pre-runner argv walk cannot do without reimplementing flag parsing — and hands the
 * leftovers to the handler, which refuses before the verb runs. A verb whose own arguments are
 * variadic absorbs its operands first and the catch-all stays empty, which is why `adr resolve` is
 * unaffected.
 *
 * The refusal is seated the way the interface convention requires
 * (`claude-plugins/fabrika/docs/cli-interface-convention.md` §2/§3, and matching #4827's shape): the
 * reason on stderr, nothing on stdout, exit `1`.
 */
import {Effect} from "effect";
import {Argument, Command, Param} from "effect/unstable/cli";
import {FAILED} from "./verb.ts";

/**
 * The catch-all's config key and argument name, exported so the coverage test can assert every leaf
 * declares it. Hidden, because the operands it collects are the ones the verb refuses — advertising
 * them in `--help` would offer an argument that does not exist.
 */
export const EXCESS_OPERAND_NAME = "excess";

const excessOperandArgument = Argument.string(EXCESS_OPERAND_NAME).pipe(
	Param.withHidden,
	Argument.atLeast(0),
);

/** The stderr line for a refusal — one line, naming every token and the path that rejected it. */
export const excessRefusal = (path: ReadonlyArray<string>, excess: ReadonlyArray<string>): string =>
	`fabrika: unexpected operand${excess.length === 1 ? "" : "s"} ${excess
		.map((token) => `"${token}"`)
		.join(", ")} for "${path.join(" ")}" — the verb declares no argument to bind it to`;

/**
 * Declare a leaf verb: `Command.make` plus the catch-all and the refusal.
 *
 * The catch-all is spread in **last** so it sits after the verb's own arguments in the parser's
 * ordered params and only ever receives what they left. Declaring a leaf with a bare `Command.make`
 * silently opts out of the guard, which `excess-operand.unit.test.ts` reds on.
 */
export const leafCommand = <
	const Name extends string,
	const Config extends Command.Command.Config,
	E,
	R,
>(
	name: Name,
	config: Config,
	handler: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<void, E, R>,
): Command.Command<Name, Command.Command.Config.Infer<Config>, object, E, R> => {
	// The runner passes the resolved command path as the handler's second argument; the public
	// overload types only the first, so the refusal reaches for it through this local shape.
	const handle = (
		input: Command.Command.Config.Infer<Config> & {
			readonly [EXCESS_OPERAND_NAME]: ReadonlyArray<string>;
		},
		path: ReadonlyArray<string>,
	): Effect.Effect<void, E, R> => {
		const excess = input[EXCESS_OPERAND_NAME];
		if (excess.length === 0) return handler(input);
		return Effect.sync(() => {
			process.stderr.write(`${excessRefusal(path, excess)}\n`);
			process.exit(FAILED);
		});
	};

	return Command.make(
		name,
		{...config, [EXCESS_OPERAND_NAME]: excessOperandArgument},
		handle as never,
	) as never;
};
