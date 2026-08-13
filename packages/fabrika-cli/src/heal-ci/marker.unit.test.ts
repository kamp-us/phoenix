import {describe, expect, it} from "vitest";
import {HEAD, OTHER_HEAD} from "../ship/fixtures.test-support.ts";
import {markerBoundTo, readMarker, renderMarker} from "./marker.ts";

const MARKER = renderMarker({head: HEAD, run: 9182736450, signature: "preview-warmup"});

describe("the rerun marker's writer and reader agree", () => {
	it("round-trips", () => {
		expect(readMarker(MARKER)).toEqual({
			head: HEAD,
			run: 9182736450,
			signature: "preview-warmup",
		});
	});

	it("matches the first line only, so a quoted marker in a reply is not one", () => {
		expect(readMarker(`someone wrote:\n\n${MARKER}\n`)).toBeNull();
	});

	it("compares the head as full 40-hex equality, never as a prefix", () => {
		const truncated = MARKER.replace(HEAD, HEAD.slice(0, 12));
		expect(readMarker(truncated)).toBeNull();
	});

	it("does not read `heal-ci note`'s narration as the machine marker", () => {
		expect(readMarker(`heal-ci: RERUN-QUEUED — PR #4321 @ ${HEAD} → rerun\n`)).toBeNull();
	});
});

describe("markerBoundTo", () => {
	it("finds a marker bound to exactly this head", () => {
		expect(markerBoundTo([{id: 7, body: MARKER}], HEAD)?.id).toBe(7);
	});

	it("ignores a marker bound to another head", () => {
		expect(markerBoundTo([{id: 7, body: MARKER}], OTHER_HEAD)).toBeNull();
	});
});
