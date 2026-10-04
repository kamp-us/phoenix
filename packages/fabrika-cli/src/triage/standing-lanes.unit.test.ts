import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {DECLARED_MEANING, offeredLanes, readStandingLanes} from "./standing-lanes.ts";

const PHOENIX_LANES = ["wayfinder:backlog", "axis:pipeline-hardening"];

const read = (files: Record<string, string | null>) =>
	Effect.runPromise(Effect.provide(readStandingLanes("/repo"), fakeFs({files}).layer));

describe("offeredLanes", () => {
	it("offers a declared lane the board carries, glossed as declared and never by name", () => {
		expect(offeredLanes(PHOENIX_LANES, new Set(PHOENIX_LANES))).toEqual([
			{label: "wayfinder:backlog", meaning: DECLARED_MEANING},
			{label: "axis:pipeline-hardening", meaning: DECLARED_MEANING},
		]);
	});

	it("offers NOTHING over a board carrying neither label — the demlik arm (#6440)", () => {
		expect(offeredLanes(PHOENIX_LANES, new Set(["bug", "enhancement"]))).toEqual([]);
	});

	it("drops only the absent one when the board carries a subset", () => {
		expect(
			offeredLanes(PHOENIX_LANES, new Set(["axis:pipeline-hardening"])).map((lane) => lane.label),
		).toEqual(["axis:pipeline-hardening"]);
	});

	it("keeps the declared order, not the board's", () => {
		const present = new Set(["axis:pipeline-hardening", "wayfinder:backlog"]);
		expect(offeredLanes(PHOENIX_LANES, present).map((lane) => lane.label)).toEqual(PHOENIX_LANES);
	});

	it("matches a label whole — a lane is not offered by a longer label that contains it", () => {
		expect(
			offeredLanes(["axis:pipeline-hardening"], new Set(["axis:pipeline-hardening-2"])),
		).toEqual([]);
	});

	it("offers nothing when the repo declares nothing, whatever the board carries", () => {
		expect(offeredLanes([], new Set(PHOENIX_LANES))).toEqual([]);
	});
});

describe("readStandingLanes", () => {
	it("resolves zero lanes over a repo declaring no config — nothing is shipped for it", async () => {
		const lanes = await read({});
		expect(lanes).toMatchObject({_tag: "Value", value: []});
	});

	it("resolves zero lanes where `boardVocabulary` is declared without the key", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"priorities": ["p0", "p1"]}}',
		});
		expect(lanes).toMatchObject({_tag: "Value", value: []});
	});

	it("takes the declared set", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": ["lane:ops"]}}',
		});
		expect(lanes).toMatchObject({_tag: "Value", value: ["lane:ops"]});
	});

	it("reads an explicitly empty declaration as zero lanes, the same answer as an absent key", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": []}}',
		});
		expect(lanes).toMatchObject({_tag: "Value", value: []});
	});

	it("REFUSES a config it cannot decode — never a silent fall back to zero lanes", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": ["lane:ops", ""]}}',
		});
		expect(lanes._tag).toBe("Refused");
	});
});
