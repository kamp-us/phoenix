import {describe, expect, it} from "vitest";
import {bindingMiss, readMarker} from "./marker.ts";

const AT = "2026-08-20T04:11:09Z";

describe("readMarker", () => {
	it("reads the marker off a comment whose first line carries it", () => {
		const read = readMarker(`campaign-approve: #47 active · ${AT}`);
		expect(read).toEqual({_tag: "Marker", marker: {milestone: 47, state: "active", at: AT}});
	});

	it("tolerates emphasis at both ends and a capitalised keyword", () => {
		const read = readMarker(`**Campaign-Approve: #47 paused · ${AT}**`);
		expect(read._tag).toBe("Marker");
	});

	it("reads only the first line, so an approval carrying its rationale still parses (#3831)", () => {
		const read = readMarker(`campaign-approve: #47 done · ${AT}\n\nBecause the arc is finished.`);
		expect(read).toEqual({_tag: "Marker", marker: {milestone: 47, state: "done", at: AT}});
	});

	it("reads a marker quoted below somebody else's opening line as no marker at all", () => {
		expect(readMarker(`I agree with this:\n\ncampaign-approve: #47 active · ${AT}`)).toEqual({
			_tag: "Absent",
		});
	});

	it("splits on CRLF too, so a comment written on Windows is not one long first line", () => {
		expect(readMarker(`campaign-approve: #47 active · ${AT}\r\nrationale`)._tag).toBe("Marker");
	});

	it("calls a comment that never reached for a marker absent, not malformed", () => {
		expect(readMarker("Ship it.")).toEqual({_tag: "Absent"});
	});

	it("calls a line that reached for the marker and missed malformed", () => {
		const read = readMarker("campaign-approve: #47 activ · nope");
		expect(read._tag).toBe("Malformed");
	});

	it("refuses a state outside the three", () => {
		expect(readMarker(`campaign-approve: #47 archived · ${AT}`)._tag).toBe("Malformed");
	});

	it("refuses a timestamp that is regex-shaped and calendar-invalid", () => {
		const read = readMarker("campaign-approve: #47 active · 2026-02-30T00:00:00Z");
		expect(read._tag).toBe("Malformed");
	});

	it("refuses a timestamp carrying an offset instead of Z", () => {
		expect(readMarker("campaign-approve: #47 active · 2026-08-20T04:11:09+00:00")._tag).toBe(
			"Malformed",
		);
	});

	it("accepts fractional seconds, which the grammar allows", () => {
		expect(readMarker("campaign-approve: #47 active · 2026-08-20T04:11:09.500Z")._tag).toBe(
			"Marker",
		);
	});

	it("refuses a hyphen separator — the separator is the middle dot", () => {
		expect(readMarker(`campaign-approve: #47 active - ${AT}`)._tag).toBe("Malformed");
	});
});

describe("bindingMiss", () => {
	const marker = {milestone: 47, state: "active"} as const;

	it("binds when both the milestone and the state match the write", () => {
		expect(bindingMiss({...marker, at: AT}, 47, "active")).toBeNull();
	});

	it("refuses an approval of another campaign", () => {
		expect(bindingMiss({...marker, at: AT}, 52, "active")).toBe(
			"approves #47 active, not #52 active",
		);
	});

	it("refuses an approval to pause as authority for a start", () => {
		expect(bindingMiss({milestone: 47, state: "paused", at: AT}, 47, "active")).toBe(
			"approves #47 paused, not #47 active",
		);
	});
});
