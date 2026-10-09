/**
 * The two inline markups a reel script carries: `*word*` accents display text, and
 * `[tone]…[/tone]` colors a span of terminal output.
 */

export interface Span {
	readonly text: string;
	readonly accent: boolean;
}

export const accentSpans = (text: string): ReadonlyArray<Span> =>
	text
		.split(/(\*[^*]+\*)/)
		.filter((part) => part.length > 0)
		.map((part) =>
			part.startsWith("*") && part.endsWith("*") && part.length > 2
				? {text: part.slice(1, -1), accent: true}
				: {text: part, accent: false},
		);

/** One display word and whether it is accented; a hook reveals text word by word. */
export const accentWords = (text: string): ReadonlyArray<Span> =>
	accentSpans(text).flatMap((span) =>
		span.text
			.split(/\s+/)
			.filter((word) => word.length > 0)
			.map((word) => ({text: word, accent: span.accent})),
	);

export const TONES = ["ok", "dim", "accent", "warn", "bad"] as const;
export type Tone = (typeof TONES)[number] | "plain";

export interface ToneSpan {
	readonly text: string;
	readonly tone: Tone;
}

const isTone = (name: string): name is (typeof TONES)[number] =>
	(TONES as ReadonlyArray<string>).includes(name);

/** Unknown or unclosed tags render as plain text rather than vanishing. */
export const toneSpans = (line: string): ReadonlyArray<ToneSpan> => {
	const spans: Array<ToneSpan> = [];
	const pattern = /\[([a-z]+)\]([^[]*)\[\/\1\]/g;
	let cursor = 0;
	for (const match of line.matchAll(pattern)) {
		const [whole, name = "", body = ""] = match;
		if (!isTone(name)) continue;
		if (match.index > cursor) spans.push({text: line.slice(cursor, match.index), tone: "plain"});
		spans.push({text: body, tone: name});
		cursor = match.index + whole.length;
	}
	if (cursor < line.length) spans.push({text: line.slice(cursor), tone: "plain"});
	return spans;
};

export const visibleText = (line: string): string =>
	toneSpans(line)
		.map((span) => span.text)
		.join("");
