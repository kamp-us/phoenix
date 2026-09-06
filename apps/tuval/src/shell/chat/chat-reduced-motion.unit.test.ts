/**
 * Every animation this stylesheet declares is cancelled under `prefers-reduced-motion`, *and* the
 * cancelling rule wins.
 *
 * The second half is the one a reader loses. `@media` is a conditional group rule: it decides
 * whether a rule applies and contributes nothing to specificity (CSS Conditional Rules 3 §3), so an
 * override written as a bare class loses to the compound selector that started the animation and
 * source order never gets a vote. That shipped once (#8121 review) and looked correct in the diff,
 * which is why it is asserted here rather than left to a reader's eye.
 */

import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const css = readFileSync(new URL("./chat.css", import.meta.url), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce) {";

/** The body of the reduced-motion block, and the stylesheet with that block cut out. */
const split = (sheet: string): {readonly reduced: string; readonly rest: string} => {
	const start = sheet.indexOf(REDUCED_MOTION);
	if (start < 0) return {reduced: "", rest: sheet};
	let depth = 0;
	for (let i = start + REDUCED_MOTION.length - 1; i < sheet.length; i++) {
		if (sheet[i] === "{") depth++;
		if (sheet[i] !== "}") continue;
		depth--;
		if (depth > 0) continue;
		return {
			reduced: sheet.slice(start + REDUCED_MOTION.length, i),
			rest: sheet.slice(0, start) + sheet.slice(i + 1),
		};
	}
	throw new Error("the reduced-motion block is unbalanced");
};

/** `(id, class, element)` per CSS Selectors 4 §17, enough for the selectors this sheet writes. */
const specificity = (selector: string): readonly [number, number, number] => [
	(selector.match(/#[\w-]+/g) ?? []).length,
	(selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length,
	(selector.match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/g) ?? []).length,
];

const atLeast = (a: readonly number[], b: readonly number[]): boolean =>
	a[0] !== b[0]
		? (a[0] ?? 0) > (b[0] ?? 0)
		: a[1] !== b[1]
			? (a[1] ?? 0) > (b[1] ?? 0)
			: (a[2] ?? 0) >= (b[2] ?? 0);

/** What the rule ultimately matches — the last compound, after any descendant combinator. */
const keyCompound = (selector: string): string =>
	(
		selector
			.trim()
			.split(/[\s>+~]+/)
			.pop() ?? ""
	).trim();

/** Every selector in `block` whose declarations start an animation. */
const animatedSelectors = (block: string): ReadonlyArray<string> =>
	[...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter(([, , body]) => /(?:^|[\s;])animation(?:-name)?\s*:\s*(?!none)/.test(body ?? ""))
		.flatMap(([, selectors]) => (selectors ?? "").split(","))
		.map((selector) => selector.trim())
		.filter(
			(selector) => selector.length > 0 && !selector.startsWith("@") && !/^\d|%$/.test(selector),
		);

describe("the reduced-motion collapse", () => {
	const {reduced, rest} = split(css);
	const overrides = [...reduced.matchAll(/([^{}]+)\{[^{}]*\}/g)]
		.flatMap(([, selectors]) => (selectors ?? "").split(","))
		.map((selector) => selector.trim())
		.filter((selector) => selector.length > 0);

	it("declares a reduced-motion block at all", () => {
		expect(reduced.trim().length).toBeGreaterThan(0);
		expect(overrides.length).toBeGreaterThan(0);
	});

	it("cancels every animation the sheet starts, with a selector that outranks it", () => {
		const animated = animatedSelectors(rest);
		expect(animated.length).toBeGreaterThan(0);
		for (const selector of animated) {
			const covering = overrides.filter(
				(override) => keyCompound(override) === keyCompound(selector),
			);
			expect(covering, `no reduced-motion override matches \`${selector}\``).not.toEqual([]);
			const wins = covering.some((override) =>
				atLeast(specificity(override), specificity(selector)),
			);
			expect(wins, `the reduced-motion override for \`${selector}\` is outranked by it`).toBe(true);
		}
	});
});
