/**
 * The palette paints nothing of its own. Every colour it shows resolves through a role token from
 * `@kampus/design`'s layer, which is the manifest's Pillar 2 rule made checkable
 * (`design-system-manifest.md`, "reach for the role layer only").
 *
 * The scan reads this directory off disk rather than trusting an import graph, so a file added here
 * later is judged without anyone remembering to list it.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const here = new URL(".", import.meta.url).pathname;

// The tests themselves are out of scope: this file has to spell the patterns it forbids, and a
// scan that judged its own source could only ever fail.
/**
 * Comments are not paint and are not judged, the rule `i18n-guard` applies to copy. An issue
 * reference (`#7643`) is shaped exactly like a hex colour, and stripping is what keeps this scan
 * from reading one as one.
 */
const withoutComments = (text: string): string =>
	text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");

const files = readdirSync(here)
	.filter((name) => /\.(ts|tsx|css)$/.test(name) && !name.includes(".test."))
	.map((name) => ({name, text: withoutComments(readFileSync(join(here, name), "utf8"))}));

/** `#rgb`, `#rrggbb`, `#rrggbbaa` — a literal colour wherever it is written. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** `rgb(…)`, `hsl(…)`, `oklch(…)` and friends: a colour function is a literal colour too. */
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/g;

/** A React `style={{…}}` prop: the other way a colour reaches an element without a token. */
const INLINE_STYLE = /style=\{\{/g;

describe("the palette's paint", () => {
	it("has files to judge", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("names no hex colour", () => {
		for (const file of files) {
			expect([file.name, file.text.match(HEX) ?? []]).toEqual([file.name, []]);
		}
	});

	it("calls no colour function", () => {
		for (const file of files) {
			expect([file.name, file.text.match(COLOR_FUNCTION) ?? []]).toEqual([file.name, []]);
		}
	});

	it("sets no inline style", () => {
		for (const file of files.filter((file) => file.name.endsWith(".tsx"))) {
			expect([file.name, file.text.match(INLINE_STYLE) ?? []]).toEqual([file.name, []]);
		}
	});

	it("reaches for role tokens and never under them", () => {
		// `--gray-N` and `--accent-N` are the semantic layer; a component consumes the role alias
		// above them (`--surface`, `--text-muted`, `--accent`) and nothing below it.
		const css = files.find((file) => file.name === "palette.css");
		expect(css).toBeDefined();
		expect(css?.text.match(/var\(--(?:gray|accent|mauve|tomato)-\d/g) ?? []).toEqual([]);
		expect((css?.text.match(/var\(--/g) ?? []).length).toBeGreaterThan(10);
	});
});
