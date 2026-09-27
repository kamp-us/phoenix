/**
 * Every animation this stylesheet declares is cancelled under `prefers-reduced-motion`, *and* the
 * cancelling rule wins.
 *
 * The second half is the one a reader loses, and it has two halves of its own. `@media` is a
 * conditional group rule: it decides whether a rule applies and contributes nothing to specificity
 * (CSS Conditional Rules 3 §3), so an override written as a bare class loses to the compound
 * selector that started the animation. That shipped once (#8121 review). And every pairing in this
 * sheet is a specificity *tie*, which the cascade decides on source order alone — so an override
 * that ties must also come later, and an animation rule appended below the block wins over it.
 * Both are asserted here rather than left to a reader's eye.
 */

import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const css = readFileSync(new URL("./chat.css", import.meta.url), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce) {";

/**
 * The body of the reduced-motion block, the stylesheet with that block cut out, and the offset the
 * block sat at. `rest` splices the two sides together, so an offset into it is below the block
 * exactly when it is below `start` — which is the whole source-order question.
 */
const split = (
	sheet: string,
): {readonly reduced: string; readonly rest: string; readonly start: number} => {
	const start = sheet.indexOf(REDUCED_MOTION);
	if (start < 0) return {reduced: "", rest: sheet, start: sheet.length};
	let depth = 0;
	for (let i = start + REDUCED_MOTION.length - 1; i < sheet.length; i++) {
		if (sheet[i] === "{") depth++;
		if (sheet[i] !== "}") continue;
		depth--;
		if (depth > 0) continue;
		return {
			reduced: sheet.slice(start + REDUCED_MOTION.length, i),
			rest: sheet.slice(0, start) + sheet.slice(i + 1),
			start,
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

/** `1` when `a` outranks `b`, `0` on a tie, `-1` when it is outranked. */
const rank = (a: readonly number[], b: readonly number[]): number => {
	for (const i of [0, 1, 2]) {
		const [left, right] = [a[i] ?? 0, b[i] ?? 0];
		if (left !== right) return left > right ? 1 : -1;
	}
	return 0;
};

/** What the rule ultimately matches — the last compound, after any descendant combinator. */
const keyCompound = (selector: string): string =>
	(
		selector
			.trim()
			.split(/[\s>+~]+/)
			.pop() ?? ""
	).trim();

/** Every selector in `block` whose declarations start an animation, with the offset it sits at. */
const animatedRules = (
	block: string,
): ReadonlyArray<{readonly selector: string; readonly at: number}> =>
	[...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter(([, , body]) => /(?:^|[\s;])animation(?:-name)?\s*:\s*(?!none)/.test(body ?? ""))
		.flatMap((match) => {
			// The rule's brace, not its match start: a match begins on the whitespace after the previous
			// rule, which for the rule directly below the cut-out block sits *above* the splice point.
			// A match with no offset is unplaceable, so read it as below everything and fail closed.
			const at =
				match.index === undefined
					? Number.POSITIVE_INFINITY
					: match.index + (match[1] ?? "").length;
			return (match[1] ?? "").split(",").map((selector) => ({selector: selector.trim(), at}));
		})
		.filter(
			({selector}) => selector.length > 0 && !selector.startsWith("@") && !/^\d|%$/.test(selector),
		);

describe("the reduced-motion collapse", () => {
	const {reduced, rest, start} = split(css);
	const overrides = [...reduced.matchAll(/([^{}]+)\{[^{}]*\}/g)]
		.flatMap(([, selectors]) => (selectors ?? "").split(","))
		.map((selector) => selector.trim())
		.filter((selector) => selector.length > 0);

	it("declares a reduced-motion block at all", () => {
		expect(reduced.trim().length).toBeGreaterThan(0);
		expect(overrides.length).toBeGreaterThan(0);
	});

	it("cancels every animation the sheet starts, with a rule that wins the cascade over it", () => {
		const animated = animatedRules(rest);
		expect(animated.length).toBeGreaterThan(0);
		for (const {selector, at} of animated) {
			const covering = overrides.filter(
				(override) => keyCompound(override) === keyCompound(selector),
			);
			expect(covering, `no reduced-motion override matches \`${selector}\``).not.toEqual([]);
			// A tie is decided by source order and nothing else, so the block has to sit below the rule
			// it cancels. `at` indexes `rest`, whose two sides are spliced at `start` — see `split`.
			const wins = covering.some((override) => {
				const ranked = rank(specificity(override), specificity(selector));
				return ranked > 0 || (ranked === 0 && start > at);
			});
			expect(
				wins,
				`the reduced-motion override for \`${selector}\` does not win the cascade over it`,
			).toBe(true);
		}
	});

	// The generic assertion above already covers this rule; it is named here because a run's
	// "still going" is the one state in the transcript a reader would otherwise read off motion.
	it("cancels the tool-run shimmer, whose state is carried by the word beside it", () => {
		const shimmer = [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
			([, selectors, body]) =>
				(selectors ?? "").includes("tuval-chat-tool-run-shimmer") &&
				/animation(?:-name)?\s*:\s*tuval-chat-tool-run-pulse/.test(body ?? ""),
		);
		expect(shimmer, "the tool-run shimmer rule is gone — re-point this assertion").toBeDefined();
		expect(overrides).toContain(".tuval-chat-tool-run-shimmer");
	});

	// Pillar 4: the collapse above is only safe if the state does not ride on the motion it cancels.
	it("leaves the in-flight dot distinguishable once the pulse is collapsed", () => {
		const declaredIn = (block: string): ReadonlyArray<string> =>
			block
				.split(";")
				.map((declaration) => (declaration.split(":")[0] ?? "").trim())
				.filter((property) => property.length > 0);

		const pulse = [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
			([, selectors, body]) =>
				(selectors ?? "").includes("tuval-chat-phase-dot") &&
				/animation(?:-name)?\s*:\s*tuval-chat-phase-pulse/.test(body ?? ""),
		);
		expect(pulse, "the phase-dot pulse rule is gone — re-point this assertion").toBeDefined();

		// What the collapse resets is what a reduced-motion reader will not see; anything else the
		// in-flight rule declares is the static tell that separates it from a settled dot.
		const reset = [...reduced.matchAll(/[^{}]+\{([^{}]*)\}/g)].flatMap(([, body]) =>
			declaredIn(body ?? ""),
		);
		const survives = declaredIn(pulse?.[2] ?? "").filter((property) => !reset.includes(property));
		expect(
			survives,
			"the in-flight dot differs from a settled one by motion alone — the reduced-motion collapse resets everything it declares",
		).not.toEqual([]);
	});
});
