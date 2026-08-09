import {describe, expect, it} from "vitest";
import {CAVEAT_KINDS, readCaveats, renderCaveats} from "./caveats.ts";

describe("readCaveats", () => {
	it("reads an empty input as zero caveats — an ordinary answer, not a refusal", () => {
		expect(readCaveats("")).toEqual({_tag: "Caveats", caveats: []});
		expect(readCaveats("\n\n")).toEqual({_tag: "Caveats", caveats: []});
	});

	it("reads one caveat per line, kind, ref and tail apart", () => {
		expect(
			readCaveats('caveat: ac-not-checkable #4302 — "works well" states no observable outcome'),
		).toEqual({
			_tag: "Caveats",
			caveats: [
				{
					kind: "ac-not-checkable",
					ref: 4302,
					text: '"works well" states no observable outcome',
				},
			],
		});
	});

	/**
	 * The *kind* is the closed half of the deliberate exception: the tail is advisory prose no verb
	 * reads back, so the enum check is the only thing keeping a caveat from minting new vocabulary.
	 */
	it("refuses a kind off the closed set", () => {
		expect(readCaveats("caveat: vibes #4302 — feels thin")).toEqual({
			_tag: "OffEnum",
			kind: "vibes",
		});
	});

	it("refuses a line that is not a caveat at all, rather than dropping it", () => {
		expect(readCaveats("this plan feels thin")._tag).toBe("Unparseable");
	});

	it.each(CAVEAT_KINDS)("admits %s", (kind) => {
		expect(readCaveats(`caveat: ${kind} #1 — note`)._tag).toBe("Caveats");
	});
});

describe("renderCaveats", () => {
	it("groups verbatim under their kinds, in the closed set's order", () => {
		const read = readCaveats(
			["caveat: slice-too-broad #2 — too big", "caveat: brief-fidelity #1 — drifted"].join("\n"),
		);
		expect(read._tag).toBe("Caveats");
		if (read._tag !== "Caveats") return;
		expect(renderCaveats(read.caveats)).toBe(
			"### brief-fidelity\n- #1 — drifted\n\n### slice-too-broad\n- #2 — too big",
		);
	});
});
