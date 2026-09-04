/**
 * The command line's lexer: whitespace separates, double quotes group, a backslash escapes the
 * character after it — inside a quoted run as well as outside one.
 *
 * Every token carries the offsets it spans in the raw input, because a refusal points at a position
 * on the line the user is still typing (#7617 R1.5); a token that knew only its text could not.
 */

/** One token, with its value resolved and the raw span it came from. */
export interface Token {
	/** The value with quotes and escapes taken out — what binds to a parameter. */
	readonly text: string;
	/** Offset of the token's first raw character, an opening quote included. */
	readonly start: number;
	/** Offset one past its last raw character. */
	readonly end: number;
}

export interface Tokenization {
	readonly tokens: ReadonlyArray<Token>;
	/**
	 * The line ends on whitespace, so the caret sits on a fresh empty token rather than inside the
	 * last one — the difference between completing `window` and completing what follows it.
	 */
	readonly trailingSeparator: boolean;
	/** A quote was opened and never closed; the last token is still being typed. */
	readonly openQuote: boolean;
}

const isSeparator = (character: string): boolean =>
	character === " " || character === "\t" || character === "\n";

export const tokenize = (input: string): Tokenization => {
	const tokens: Array<Token> = [];
	let cursor = 0;
	let openQuote = false;

	while (cursor < input.length) {
		while (cursor < input.length && isSeparator(input.charAt(cursor))) cursor += 1;
		if (cursor >= input.length) break;

		const start = cursor;
		let text = "";
		let quoted = false;
		while (cursor < input.length) {
			const character = input.charAt(cursor);
			if (character === "\\") {
				// A backslash at the very end of the line escapes nothing yet: the user is mid-keystroke,
				// so it contributes no character rather than refusing the line.
				if (cursor + 1 < input.length) text += input.charAt(cursor + 1);
				cursor += cursor + 1 < input.length ? 2 : 1;
				continue;
			}
			if (character === '"') {
				quoted = !quoted;
				cursor += 1;
				continue;
			}
			if (!quoted && isSeparator(character)) break;
			text += character;
			cursor += 1;
		}
		openQuote = quoted;
		tokens.push({text, start, end: cursor});
	}

	const last = tokens[tokens.length - 1];
	return {
		tokens,
		trailingSeparator: last === undefined ? input.length > 0 : last.end < input.length,
		openQuote,
	};
};
