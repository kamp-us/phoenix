/**
 * `agy --print='/help' --output-format=json` → the `CommandRef`s the composer's picker lists.
 *
 * A different envelope from the streaming one `wire.ts` reads, and this is the only place it is
 * read: `--output-format=json` prints one flat object per invocation, with the slash-command
 * catalog under `command.data.commands[]`. Captured at v1.1.27:
 *
 * ```json
 * {"conversation_id":"","status":"SUCCESS","response":"…","num_turns":0,
 *  "usage":{"input_tokens":0,…},
 *  "command":{"name":"help","data":{"commands":[
 *    {"name":"agents","description":"List available custom agents"},
 *    {"name":"config","aliases":["settings"],"description":"Open settings panel"}]}}}
 * ```
 *
 * Pure and total: unreadable output is an empty catalog, never a throw. A picker with no rows is
 * the honest answer to a CLI that would not say, and a `commands` read declares no error channel.
 *
 * An alias is emitted as a row of its own rather than folded into a hint. `CommandRef.name` is what
 * the composer inserts, so `/settings` has to be insertable as itself; a description that merely
 * mentioned it would list a command the picker could not produce.
 */

import type {CommandRef} from "../../ai-agent/ports/index.ts";

interface Fields {
	readonly [key: string]: unknown;
}

const fields = (value: unknown): Fields | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Fields)
		: undefined;

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const refsOf = (value: unknown): ReadonlyArray<CommandRef> => {
	const row = fields(value);
	if (row === undefined) return [];
	const name = text(row.name);
	if (name === undefined) return [];
	const description = text(row.description);
	const described = description === undefined ? {} : {description};
	const aliases = Array.isArray(row.aliases) ? row.aliases : [];
	return [
		{name, ...described},
		...aliases.flatMap((alias) => {
			const spelled = text(alias);
			return spelled === undefined ? [] : [{name: spelled, ...described}];
		}),
	];
};

/** One `/help` invocation's stdout → the catalog. Anything it cannot read answers empty. */
export const commandsOf = (stdout: string): ReadonlyArray<CommandRef> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const commands = fields(fields(fields(parsed)?.command)?.data)?.commands;
	return Array.isArray(commands) ? commands.flatMap(refsOf) : [];
};
