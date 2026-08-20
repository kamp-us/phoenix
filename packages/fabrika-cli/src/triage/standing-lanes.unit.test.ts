import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {DECLARED_MEANING, offeredLanes, readStandingLanes} from "./standing-lanes.ts";

const PHOENIX_LANES = ["wayfinder:backlog", "axis:pipeline-hardening"];

const read = (files: Record<string, string | null>) =>
	Effect.runPromise(Effect.provide(readStandingLanes("/repo"), fakeFs({files}).layer));

describe("offeredLanes", () => {
	it("offers a declared lane the board carries, with its shipped meaning", () => {
		expect(offeredLanes(PHOENIX_LANES, new Set(PHOENIX_LANES))).toEqual([
			{label: "wayfinder:backlog", meaning: "fog — uncharted work upstream of any arc"},
			{
				label: "axis:pipeline-hardening",
				meaning: "the standing pipeline and reliability lane",
			},
		]);
	});

	it("offers NOTHING over a board carrying neither label — the demlik arm (#6440)", () => {
		expect(offeredLanes(PHOENIX_LANES, new Set(["bug", "enhancement"]))).toEqual([]);
	});

	it("drops only the absent one when the board carries a subset", () => {
		expect(offeredLanes(PHOENIX_LANES, new Set(["axis:pipeline-hardening"]))).toEqual([
			{
				label: "axis:pipeline-hardening",
				meaning: "the standing pipeline and reliability lane",
			},
		]);
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

	it("says a lane it has no shipped meaning for is one this repo declares, rather than inventing a gloss", () => {
		expect(offeredLanes(["lane:ops"], new Set(["lane:ops"]))).toEqual([
			{label: "lane:ops", meaning: DECLARED_MEANING},
		]);
	});

	it("offers nothing when the repo declares nothing, whatever the board carries", () => {
		expect(offeredLanes([], new Set(PHOENIX_LANES))).toEqual([]);
	});
});

describe("readStandingLanes", () => {
	it("resolves the shipped default over a repo declaring no config", async () => {
		const lanes = await read({});
		expect(lanes).toMatchObject({_tag: "Value", value: PHOENIX_LANES});
	});

	it("takes the declared set over the default", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": ["lane:ops"]}}',
		});
		expect(lanes).toMatchObject({_tag: "Value", value: ["lane:ops"]});
	});

	/**
	 * The `declares none` arm has to be reachable from a config file, or `triage homes` documents a
	 * state no operator can produce (#6440). An absent key is a different answer — the default.
	 */
	it("reads an explicitly empty declaration as zero lanes, not as the default", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": []}}',
		});
		expect(lanes).toMatchObject({_tag: "Value", value: []});
	});

	it("REFUSES a config it cannot decode — never a silent fall back to phoenix's lanes", async () => {
		const lanes = await read({
			"/repo/.fabrika.jsonc": '{"boardVocabulary": {"standingLanes": ["lane:ops", ""]}}',
		});
		expect(lanes._tag).toBe("Refused");
	});
});
