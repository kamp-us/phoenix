/**
 * Why a command line did not become a Msg. Every arm is JSON and nothing here throws, for the same
 * reason the picker's refusals are JSON (`../picker/refusal.ts`): a refusal is shown under the line
 * the user is still typing, so it rides the transport and survives a restart like the rest of the
 * desk.
 *
 * Every arm carries `position`, the offset of the offending token's first character in the raw
 * input, because a refusal points at a place on the line — the same contract the framework parser's
 * `Refused` holds (`.patterns/tuval-spells.md`, "The parser").
 */

export type CommandRefusal =
	/** The line held nothing but whitespace. */
	| {readonly _tag: "EmptyCommandLine"; readonly position: number}
	/** No row is named this. `didYouMean` is present only when one name is near enough to be a typo. */
	| {
			readonly _tag: "UnknownCommand";
			readonly verb: string;
			readonly position: number;
			readonly didYouMean?: string;
	  }
	/** The row needs a parameter the line did not give it. */
	| {
			readonly _tag: "MissingArgument";
			readonly command: string;
			readonly parameter: string;
			readonly position: number;
	  }
	/** The row's schema refused a value the line did give it. */
	| {
			readonly _tag: "BadArgument";
			readonly command: string;
			readonly parameter: string;
			readonly expected: string;
			readonly position: number;
	  }
	/** The line held a token past the row's last parameter. */
	| {
			readonly _tag: "TooManyArguments";
			readonly command: string;
			readonly parameters: number;
			readonly position: number;
	  };

export const emptyCommandLine = (position: number): CommandRefusal => ({
	_tag: "EmptyCommandLine",
	position,
});

export const unknownCommand = (
	verb: string,
	position: number,
	didYouMean?: string,
): CommandRefusal => ({
	_tag: "UnknownCommand",
	verb,
	position,
	...(didYouMean === undefined ? {} : {didYouMean}),
});

export const missingArgument = (
	command: string,
	parameter: string,
	position: number,
): CommandRefusal => ({_tag: "MissingArgument", command, parameter, position});

export const badArgument = (
	command: string,
	parameter: string,
	expected: string,
	position: number,
): CommandRefusal => ({_tag: "BadArgument", command, parameter, expected, position});

export const tooManyArguments = (
	command: string,
	parameters: number,
	position: number,
): CommandRefusal => ({_tag: "TooManyArguments", command, parameters, position});

/**
 * The refusal as the line announces it. One function, so no surface composes its own wording: the
 * page reads this string under the input and a test reads the same string.
 */
export const refusalMessage = (refusal: CommandRefusal): string => {
	switch (refusal._tag) {
		case "EmptyCommandLine":
			return "Type a command name.";
		case "UnknownCommand": {
			const hint = refusal.didYouMean === undefined ? "" : ` Did you mean "${refusal.didYouMean}"?`;
			return `No command row is named "${refusal.verb}".${hint}`;
		}
		case "MissingArgument":
			return `"${refusal.command}" needs a ${refusal.parameter}.`;
		case "BadArgument":
			return `"${refusal.command}" refused its ${refusal.parameter}: ${refusal.expected}`;
		case "TooManyArguments":
			return refusal.parameters === 0
				? `"${refusal.command}" takes no arguments.`
				: `"${refusal.command}" takes ${refusal.parameters} argument(s).`;
	}
};
