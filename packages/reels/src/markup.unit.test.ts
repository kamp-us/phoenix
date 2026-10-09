import {describe, expect, it} from "vitest";
import {accentSpans, accentWords, toneSpans, visibleText} from "./markup.ts";

describe("accent markup", () => {
	it("paints only the starred words", () => {
		expect(accentSpans("ship the *PR.*")).toEqual([
			{text: "ship the ", accent: false},
			{text: "PR.", accent: true},
		]);
	});

	it("counts words through the markup", () => {
		expect(accentWords("*Neovim + tmux,* but for agents.").map((word) => word.text)).toEqual([
			"Neovim",
			"+",
			"tmux,",
			"but",
			"for",
			"agents.",
		]);
	});
});

describe("tone markup", () => {
	it("colors closed spans and keeps the rest plain", () => {
		expect(toneSpans("[ok]✓ merged[/ok] at [accent]56fe289[/accent]")).toEqual([
			{text: "✓ merged", tone: "ok"},
			{text: " at ", tone: "plain"},
			{text: "56fe289", tone: "accent"},
		]);
	});

	it("leaves an unknown tag visible rather than dropping it", () => {
		expect(visibleText("[blink]x[/blink]")).toBe("[blink]x[/blink]");
	});
});
