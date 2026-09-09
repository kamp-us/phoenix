/** Shell rows resolve first; only an unknown shell verb reaches the shared registered-spell parser. */

import {Result, Schema} from "effect";
import {didYouMean} from "../../commands/parse/did-you-mean.ts";
import {parse} from "../../commands/parse/parse.ts";
import type {SpellIndex} from "../../commands/parse/spell-index.ts";
import {tokenize} from "../../commands/parse/tokenize.ts";
import type {CallId, WindowId} from "../../protocol/ids.ts";
import {firstSchemaIssue} from "../../protocol/issue.ts";
import {PROTOCOL_VERSION, type Snapshot, SpellCall} from "../../protocol/messages.ts";
import type {ShellMsg} from "../core/machine.ts";
import {
	badArgument,
	type CommandRefusal,
	emptyCommandLine,
	missingArgument,
	tooManyArguments,
	unknownCommand,
} from "./errors.ts";
import {type AnyShellCommand, commandName, isOptionalParameter, parameterNames} from "./row.ts";
import {resolveVerb, verbSpellings} from "./table.ts";

export type CommandLineResult =
	| {readonly _tag: "Msg"; readonly command: AnyShellCommand; readonly msg: ShellMsg}
	| {readonly _tag: "Refused"; readonly refusal: CommandRefusal};

export interface RegisteredLineOptions {
	readonly registry: SpellIndex;
	readonly snapshot: Snapshot;
	readonly id: CallId;
	readonly window?: WindowId | undefined;
}

export type RegisteredLineResult =
	| CommandLineResult
	| {readonly _tag: "Spell"; readonly call: SpellCall};

const refused = (refusal: CommandRefusal): CommandLineResult => ({_tag: "Refused", refusal});

/**
 * Read one line. A verb resolves by its full name (`window:open`) or by its last segment when no
 * other row claims that segment (`open`), which is what makes `prefix :open counter` read.
 */
export function readCommandLine(input: string): CommandLineResult;
export function readCommandLine(
	input: string,
	options: RegisteredLineOptions,
): RegisteredLineResult;
export function readCommandLine(
	input: string,
	options?: RegisteredLineOptions,
): RegisteredLineResult {
	const {tokens} = tokenize(input);
	const [verb, ...args] = tokens;
	if (verb === undefined) return refused(emptyCommandLine(input.length));

	const command = resolveVerb(verb.text);
	if (command === undefined) {
		if (options !== undefined) {
			const parsed = parse(input, options.registry, options.snapshot);
			if (parsed._tag === "Complete")
				return {
					_tag: "Spell",
					call: new SpellCall({
						type: "spell.call",
						version: PROTOCOL_VERSION,
						id: options.id,
						...parsed.call,
						...(options.window === undefined ? {} : {window: options.window}),
					}),
				};
			return refused(
				parsed._tag === "Refused"
					? {
							_tag: "SpellParseRefused",
							position: parsed.position,
							expected: parsed.expected,
							...(parsed.didYouMean === undefined ? {} : {didYouMean: parsed.didYouMean}),
						}
					: {
							_tag: "SpellParseRefused",
							position: input.length,
							expected:
								parsed.cursorArg === undefined
									? `a complete command${parsed.candidates.length === 0 ? "" : ` (${parsed.candidates.map((candidate) => candidate.value).join(", ")})`}`
									: `a value for ${parsed.cursorArg.name}`,
						},
			);
		}
		return refused(unknownCommand(verb.text, verb.start, didYouMean(verb.text, verbSpellings)));
	}

	const name = String(commandName(command.path));
	const parameters = parameterNames(command);
	const extra = args[parameters.length];
	if (extra !== undefined) {
		return refused(tooManyArguments(name, parameters.length, extra.start));
	}

	const values: Record<string, string> = {};
	for (const [index, parameter] of parameters.entries()) {
		const token = args[index];
		if (token === undefined) {
			// An optional parameter the line did not reach stays absent, which is what its schema
			// admits; a required one is a refusal, and the caret is past the last token the line
			// holds, so it points at the end.
			if (isOptionalParameter(command, parameter)) continue;
			return refused(missingArgument(name, parameter, input.length));
		}
		values[parameter] = token.text;
	}

	const decoded = Schema.decodeUnknownResult(command.params)(values);
	if (Result.isFailure(decoded)) {
		const {expected, at} = firstSchemaIssue(decoded.failure);
		const parameter = at.length === 0 ? (parameters[0] ?? "argument") : at;
		const token = args[parameters.indexOf(parameter)];
		return refused(badArgument(name, parameter, expected, token?.start ?? input.length));
	}

	return {_tag: "Msg", command, msg: command.toMsg(decoded.success)};
}
