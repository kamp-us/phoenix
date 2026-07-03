/**
 * `@kampus/aria-voice-guard` core — the pure, IO-free matcher that flags a
 * Title-Case aria-label or persistent menu-item string in `apps/web/src`, so the
 * lowercase anti-hype Turkish register can't silently re-drift at the a11y / menu
 * seam (issue #1670).
 *
 * The non-obvious, load-bearing part is Turkish-locale casing. Turkish has the
 * dotted/dotless i pair (İ/i and I/ı), so "is this string Title Case?" and any
 * lowercasing MUST go through `toLocaleLowerCase("tr")` / `toLocaleUpperCase("tr")`
 * — a naive `toLowerCase()` maps "İletişim" → "i̇letişim" (a stray combining dot)
 * and "Istanbul" → "istanbul" (wrong: dotless-I lowercases to "ı", so the correct
 * form is "ıstanbul"). `firstCasedIsUpper` decides drift by comparing a string's
 * first *cased* letter against its Turkish-locale lowercase — a letter with no case
 * distinction (a digit, a symbol, an already-lowercase letter) is never a false
 * positive, and a genuinely Title-Case Turkish word is never a false negative.
 *
 * The scan is deliberately scoped: only aria-label VALUES and persistent menu-item
 * TEXT are candidates, and only their *string-literal* parts — a dynamic
 * `aria-label={count + " bildirim"}` interpolation or a `{expr}` menu child is not a
 * fixed copy string, so it is out of scope (the visible voice of a dynamic value is
 * the interpolated data's problem, not this guard's). The exact candidate set + the
 * false-positive carve-outs are pinned in `aria-voice-guard.unit.test.ts`.
 */

export interface Finding {
	/** 1-based line number of the offending string in the scanned file. */
	readonly line: number;
	/** Which surface flagged it — an a11y label or a persistent menu item. */
	readonly kind: "aria-label" | "menu-item";
	/** The exact Title-Case string literal that drifted. */
	readonly text: string;
	/** The lowercase Turkish-voice form it should be. */
	readonly suggestion: string;
}

const TR_LOWER = (s: string): string => s.toLocaleLowerCase("tr");

/**
 * True iff `s`'s first *cased* letter is uppercase under Turkish-locale rules.
 * A leading run of case-less characters (digits, punctuation, whitespace) is
 * skipped; the decision is made on the first character that actually changes
 * under `toLocaleLowerCase("tr")`. A string with no cased letter at all
 * (all digits/symbols) is never flagged.
 */
export const firstCasedIsUpper = (s: string): boolean => {
	for (const ch of s) {
		const lower = TR_LOWER(ch);
		if (lower !== ch) return true; // ch differs from its lowercase ⇒ ch is uppercase
		const upper = ch.toLocaleUpperCase("tr");
		if (upper !== ch) return false; // ch has an uppercase form but equals its lowercase ⇒ already lowercase
		// else: case-less char (digit/symbol/whitespace) — skip, look at the next one
	}
	return false;
};

/** The lowercase Turkish-voice form of a whole label/menu string. */
export const toLowerVoice = (s: string): string => TR_LOWER(s);

// The aria-label attribute value: either a `{ ... }` expression container (a
// ternary, a call, a template — captured whole, no nested braces) OR a single
// quoted string. Every STRING LITERAL inside that value is then a candidate. A bare
// `aria-label={expr}` with no literal (a variable / an interpolated template) yields
// no literal, so it is out of scope by construction. Matching the brace group as a
// unit is what lets a multi-word value like `"Yukarı oy"` survive — a space inside
// the quotes no longer truncates the attribute.
const ARIA_ATTR = /aria-label=(\{[^{}]*\}|"[^"\n]*"|'[^'\n]*')/g;
const STRING_LITERAL = /"([^"\n]*)"|'([^'\n]*)'/g;

// A persistent menu-item's plain text child: `<Menu.Item ...> text </Menu.Item>`
// where the child is a literal (no `{`), on the item's line or the next. Covers the
// BaseUI `Menu.Item` used by the topbar user-menu and the pano comment menu.
const MENU_ITEM = /<Menu\.Item\b[^>]*>([^<{]*)<\/Menu\.Item>/g;
const MENU_ITEM_OPEN = /<Menu\.Item\b[^>]*>\s*$/;

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** Every aria-label / menu-item Title-Case drift in `source` (a .tsx file's text). */
export const findDrift = (source: string): ReadonlyArray<Finding> => {
	const findings: Finding[] = [];

	for (const attr of source.matchAll(ARIA_ATTR)) {
		const body = attr[1] ?? "";
		const attrIndex = attr.index ?? 0;
		for (const lit of body.matchAll(STRING_LITERAL)) {
			const text = lit[1] ?? lit[2] ?? "";
			if (text.length > 0 && firstCasedIsUpper(text)) {
				findings.push({
					line: lineOf(source, attrIndex),
					kind: "aria-label",
					text,
					suggestion: toLowerVoice(text),
				});
			}
		}
	}

	// Single-line `<Menu.Item>text</Menu.Item>`.
	for (const item of source.matchAll(MENU_ITEM)) {
		const text = (item[1] ?? "").trim();
		if (text.length > 0 && firstCasedIsUpper(text)) {
			findings.push({
				line: lineOf(source, item.index ?? 0),
				kind: "menu-item",
				text,
				suggestion: toLowerVoice(text),
			});
		}
	}

	// Multi-line `<Menu.Item ...>` whose text child sits on the following line(s).
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const openLine = lines[i];
		if (openLine === undefined || !MENU_ITEM_OPEN.test(openLine)) continue;
		const child = lines[i + 1]?.trim() ?? "";
		if (child.startsWith("{") || child.startsWith("<") || child.length === 0) continue;
		if (firstCasedIsUpper(child)) {
			findings.push({
				line: i + 2, // the child line, 1-based
				kind: "menu-item",
				text: child,
				suggestion: toLowerVoice(child),
			});
		}
	}

	return findings;
};
