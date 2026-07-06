/**
 * The on-brand controlled-asset render pass (#2165, pillar cohesiveness): the bar
 * paints each palette member as a monochrome inline-SVG line-icon instead of its
 * raw OS emoji glyph (so it renders identically across OSes and coheres with the
 * monochrome-plus-accent palette), and names each button by ADR 0139's Turkish
 * gloss. These assert the render contract the later ReactionBar convergence passes
 * (#2166 contrast/focus, #2169 systematic focus/ARIA) build on.
 */
import {render} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {REACTION_EMOJI} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {ReactionBar} from "./ReactionBar";
import {REACTION_GLOSS} from "./reactionModel";

describe("ReactionBar — on-brand controlled-asset render (#2165)", () => {
	it("renders one inline-SVG line-icon per palette member, not the raw emoji glyph", () => {
		const {container} = render(
			<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t1" />,
		);
		// One controlled SVG glyph per palette member — the OS-invariant asset.
		const glyphs = container.querySelectorAll("svg.kp-reaction-bar__glyph");
		expect(glyphs).toHaveLength(REACTION_EMOJI.length);
		// The raw emoji text is no longer painted as a glyph (it stays the key/label only).
		expect(container.querySelector(".kp-reaction-bar__emoji")).toBeNull();
	});

	it("paints the glyph in currentColor so it inherits the button's token", () => {
		const {container} = render(
			<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t2" />,
		);
		for (const svg of container.querySelectorAll("svg.kp-reaction-bar__glyph")) {
			expect(svg.getAttribute("stroke")).toBe("currentColor");
		}
	});

	it("names each button by ADR 0139's Turkish gloss (the accessible name)", () => {
		const {getByTestId} = render(
			<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t3" />,
		);
		for (const emoji of REACTION_EMOJI) {
			const btn = getByTestId(`reaction-${emoji}-t3`);
			expect(btn.getAttribute("aria-label")).toBe(REACTION_GLOSS[emoji]);
		}
	});

	it("folds the count into the gloss accessible name when a member has reactions", () => {
		const aggregate: ReactionAggregate = {counts: [{emoji: "🔥", count: 3}], myReaction: null};
		const {getByTestId} = render(
			<ReactionBar aggregate={aggregate} onReact={vi.fn()} testIdSuffix="t4" />,
		);
		expect(getByTestId("reaction-🔥-t4").getAttribute("aria-label")).toBe(
			`${REACTION_GLOSS["🔥"]} (3)`,
		);
	});

	it("marks the glyph decorative (aria-hidden) — the name lives on the button", () => {
		const {container} = render(
			<ReactionBar aggregate={null} onReact={vi.fn()} testIdSuffix="t5" />,
		);
		for (const svg of container.querySelectorAll("svg.kp-reaction-bar__glyph")) {
			expect(svg.getAttribute("aria-hidden")).toBe("true");
		}
	});
});
