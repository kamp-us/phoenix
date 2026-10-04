/**
 * How a JSON file lays out its bytes, read off the file so a rewrite keeps it: the indent one nesting
 * level adds, the line ending, and whether the last line ends on one. A merge that re-serializes a
 * present file renders through the layout it read, so the diff carries the changed rows and nothing
 * else.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10032
 */
export interface JsonLayout {
	/** One nesting level, exactly as the file spells it — `"\t"`, `"  "`, `"    "`. */
	readonly indent: string;
	readonly eol: "\n" | "\r\n";
	readonly finalNewline: boolean;
}

/** The layout of a file written from nothing: tab-indented, `\n` line endings, a final newline. */
export const FRESH_JSON_LAYOUT: JsonLayout = {indent: "\t", eol: "\n", finalNewline: true};

/** `JSON.stringify` silently truncates a longer indent string, so a longer one cannot round-trip. */
const MAX_INDENT = 10;

/**
 * The layout `text` already uses. The first indented line holds one level of indent in any
 * pretty-printed JSON, so its leading whitespace is the unit. A file with no indented line — `{}`,
 * or one minified line — has no indent to keep, and takes the fresh layout's.
 */
export const readJsonLayout = (text: string): JsonLayout => {
	const unit = /\n([ \t]+)\S/.exec(text)?.[1];
	return {
		indent: unit === undefined || unit.length > MAX_INDENT ? FRESH_JSON_LAYOUT.indent : unit,
		eol: text.includes("\r\n") ? "\r\n" : "\n",
		finalNewline: /\n$/.test(text),
	};
};

/** `value` rendered in `layout`. String values escape their newlines, so every raw `\n` is a line break. */
export const renderJson = (value: unknown, layout: JsonLayout): string => {
	const body = JSON.stringify(value, null, layout.indent);
	const lines = layout.eol === "\n" ? body : body.replace(/\n/g, "\r\n");
	return layout.finalNewline ? `${lines}${layout.eol}` : lines;
};
