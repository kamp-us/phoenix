/**
 * The command line: a typed line in, one core Msg or one typed refusal out. Total, synchronous and
 * never throwing, because the surface runs it on the line the user is still typing.
 *
 * It lexes with the framework's own `tokenize` and suggests with the framework's own `didYouMean`
 * (`../../commands/parse/`), so `"a b"` groups here exactly as it groups in the palette and one
 * typo reads the same wherever it is caught. What is this module's own is the binding: a verb, then
 * its parameters positionally in declaration order, decoded against the row's real Effect `Schema`
 * — which is why a refusal can name the row *and* the parameter, where the palette's parser binds
 * argument text and leaves the decode to the kernel's executor.
 */

import {Result, Schema} from "effect";
import {didYouMean} from "../../commands/parse/did-you-mean.ts";
import {tokenize} from "../../commands/parse/tokenize.ts";
import {firstSchemaIssue} from "../../protocol/issue.ts";
import type {ShellMsg} from "../core/machine.ts";
import {
	badArgument,
	type CommandRefusal,
	emptyCommandLine,
	missingArgument,
	tooManyArguments,
	unknownCommand,
} from "./errors.ts";
import {type AnyShellCommand, commandName, parameterNames} from "./row.ts";
import {resolveVerb, verbSpellings} from "./table.ts";

export type CommandLineResult =
	| {readonly _tag: "Msg"; readonly command: AnyShellCommand; readonly msg: ShellMsg}
	| {readonly _tag: "Refused"; readonly refusal: CommandRefusal};

const refused = (refusal: CommandRefusal): CommandLineResult => ({_tag: "Refused", refusal});

/**
 * Read one line. A verb resolves by its full name (`window:open`) or by its last segment when no
 * other row claims that segment (`open`), which is what makes `prefix :open counter` read.
 */
export const readCommandLine = (input: string): CommandLineResult => {
	const {tokens} = tokenize(input);
	const [verb, ...args] = tokens;
	if (verb === undefined) return refused(emptyCommandLine(input.length));

	const command = resolveVerb(verb.text);
	if (command === undefined) {
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
		// The caret is past the last token the line holds, so a missing argument points at its end.
		if (token === undefined) return refused(missingArgument(name, parameter, input.length));
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
};
