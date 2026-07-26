/**
 * The pure router core — argv → registered tool, decoupled from the Effect CLI
 * runtime (epic #994).
 *
 * `effect/unstable/cli`'s `Command.withSubcommands` already does the *runtime*
 * dispatch in `bin.ts`. This module is the **pure, directly-testable** mirror of
 * that resolution: given the registry and a raw argv, which tool does the first
 * token select, and what happens for an unknown token. It owns no IO and no
 * Effect runtime, so the dispatch contract — correct tool for a known name, a
 * clear typed error for an unknown one — is unit-testable without spawning a CLI
 * (ADR 0082). The router is closed for modification: new tools arrive only
 * via `registry.ts`, never by editing this file.
 *
 * It resolves on `name` alone, so it dispatches a lazy `ToolRegistration` — the row
 * `run.ts` must select *before* loading any module (#4008) — as readily as a loaded
 * `Command`; both carry the selector.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";

/** The first argv token named no registered tool. Carries the offender + the known set. */
export class UnknownToolError extends Schema.TaggedErrorClass<UnknownToolError>()(
	"UnknownToolError",
	{
		tool: Schema.String,
		known: Schema.Array(Schema.String),
	},
) {
	override get message(): string {
		return `unknown tool "${this.tool}" — known tools: ${this.known.join(", ") || "(none)"}`;
	}
}

/** No argv token at all (`pipeline-cli` with no subcommand) — the help/usage case. */
export class NoToolError extends Schema.TaggedErrorClass<NoToolError>()("NoToolError", {
	known: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `no tool given — known tools: ${this.known.join(", ") || "(none)"}`;
	}
}

/** All the router needs of a registry row: the selector it dispatches on. */
export interface NamedTool {
	readonly name: string;
}

/** The names of every registered tool, in registry order. */
export const toolNames = (registry: ReadonlyArray<NamedTool>): ReadonlyArray<string> =>
	registry.map((tool) => tool.name);

/**
 * Resolve `argv` against the registry: the first token selects a tool; the
 * remaining tokens are that tool's own args (the router never interprets them).
 *
 * - first token names a registered tool ⇒ `Ok({ tool, rest })`
 * - first token names no registered tool ⇒ `Err(UnknownToolError)` (a clear,
 *   non-zero-exit-worthy failure — AC #2)
 * - empty argv ⇒ `Err(NoToolError)` (the help/usage case)
 */
export const dispatch = <T extends NamedTool>(
	registry: ReadonlyArray<T>,
	argv: ReadonlyArray<string>,
): Result.Result<
	{readonly tool: T; readonly rest: ReadonlyArray<string>},
	UnknownToolError | NoToolError
> => {
	const [head, ...rest] = argv;
	if (head === undefined) {
		return Result.fail(new NoToolError({known: toolNames(registry)}));
	}
	const tool = registry.find((t) => t.name === head);
	return tool === undefined
		? Result.fail(new UnknownToolError({tool: head, known: toolNames(registry)}))
		: Result.succeed({tool, rest});
};
