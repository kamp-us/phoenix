import {describe, expect, it} from "vitest";
import {soundEvents} from "./audio.ts";
import type {Reel} from "./reel.ts";
import {
	FPS,
	judgeReel,
	MAX_SECONDS,
	planTimeline,
	TERMINAL_COLUMNS,
	terminalCues,
} from "./timeline.ts";

const reel = (scenes: Reel["scenes"]): Reel => ({
	id: "test",
	brand: "fabrika",
	title: "t",
	description: "d",
	hashtags: [],
	scenes,
});

const fits = reel([
	{_tag: "hook", text: "You file the *issue.*"},
	{_tag: "terminal", lines: [{cmd: "fabrika status"}, {out: "[ok]merged[/ok]"}]},
	{_tag: "outro", text: "Follow.", cta: "Follow"},
]);

describe("judgeReel", () => {
	it("admits a reel that opens on a hook, closes on an outro and fits", () => {
		expect(judgeReel(fits)._tag).toBe("Fits");
	});

	it("refuses a reel that does not open on its hook", () => {
		const verdict = judgeReel(
			reel([
				{_tag: "stat", value: 1, label: "x"},
				{_tag: "outro", text: "x", cta: "x"},
			]),
		);
		expect(verdict._tag === "Refused" ? verdict.reasons[0] : "fits").toMatch(/opens on its hook/);
	});

	it("refuses a terminal line wider than the terminal, counting visible columns only", () => {
		const wide = `[ok]${"x".repeat(TERMINAL_COLUMNS + 1)}[/ok]`;
		const verdict = judgeReel(
			reel([
				{_tag: "hook", text: "h"},
				{_tag: "terminal", lines: [{out: wide}]},
				{_tag: "outro", text: "o", cta: "c"},
			]),
		);
		expect(verdict._tag).toBe("Refused");
		const exact = `[ok]${"x".repeat(TERMINAL_COLUMNS)}[/ok]`;
		expect(
			judgeReel(
				reel([
					{_tag: "hook", text: "h"},
					{_tag: "terminal", lines: [{out: exact}]},
					{_tag: "outro", text: "o", cta: "c"},
				]),
			)._tag,
		).toBe("Fits");
	});

	it("refuses a reel past the length ceiling", () => {
		const long = Array.from({length: 20}, () => ({
			_tag: "stat" as const,
			value: 1,
			label: "one two three four five six",
		}));
		const verdict = judgeReel(
			reel([{_tag: "hook", text: "h"}, ...long, {_tag: "outro", text: "o", cta: "c"}]),
		);
		expect(verdict._tag === "Refused" ? verdict.reasons.join() : "fits").toMatch(
			new RegExp(`exceeds ${MAX_SECONDS}s`),
		);
	});
});

describe("planTimeline", () => {
	it("lays scenes end to end", () => {
		const timeline = planTimeline(fits);
		const [first, second] = timeline.scenes;
		expect(second?.startFrame).toBe((first?.startFrame ?? 0) + (first?.frames ?? 0));
		expect(timeline.totalFrames).toBe(
			timeline.scenes.reduce((sum, scene) => sum + scene.frames, 0),
		);
	});

	it("holds a terminal until its last line has been on screen", () => {
		const [, terminal] = fits.scenes;
		if (terminal?._tag !== "terminal") throw new Error("fixture");
		const last = terminalCues(terminal.lines).at(-1)?.end ?? 0;
		expect((planTimeline(fits).scenes[1]?.frames ?? 0) / FPS).toBeGreaterThan(last + 1);
	});
});

describe("soundEvents", () => {
	it("types one key per command character, inside its scene", () => {
		const timeline = planTimeline(fits);
		const keys = soundEvents(fits, timeline).filter((event) => event.kind === "key");
		expect(keys).toHaveLength("fabrika status".length);
		const start = (timeline.scenes[1]?.startFrame ?? 0) / FPS;
		expect(keys.every((event) => event.at >= start)).toBe(true);
	});

	it("whooshes once into every scene after the first", () => {
		expect(
			soundEvents(fits, planTimeline(fits)).filter((event) => event.kind === "whoosh"),
		).toHaveLength(2);
	});
});
