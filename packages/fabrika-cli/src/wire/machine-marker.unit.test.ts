import {describe, expect, it} from "vitest";
import {emit, markedIssue, rulingUrl, scopeDigest} from "./decision-ruling.ts";
import {markerTime} from "./grill-marker.ts";
import {carriesMachineMarker} from "./machine-marker.ts";

const REPO = "o/r";

const conforming = emit({
	issue: markedIssue(4287) ?? (0 as never),
	digest: scopeDigest("4d90e1bb27ac") ?? ("" as never),
	ruling: rulingUrl(`https://github.com/${REPO}/issues/4287#issuecomment-900001`) ?? ("" as never),
	supersedes: null,
	at: markerTime("2026-09-20T06:00:00Z") ?? ("" as never),
});

describe("carriesMachineMarker", () => {
	it("reads a conforming decision-ruled line as a marker", () => {
		expect(carriesMachineMarker(conforming)).toBe(true);
	});

	it("reads a drifted decision-ruled line as no marker", () => {
		expect(
			carriesMachineMarker(
				"decision-ruled: #4287 @ NOTADIGEST · ruling:x · 2026-09-20T06:00:00Z\n",
			),
		).toBe(false);
	});

	it.each([
		["a hyphenated key line", "build-claim: build:s:n · 2026-09-20T05:00:00Z"],
		["a bold hyphenated key line", "**review-code: PASS @ a1b2c3d — fine**"],
		["a key line after blank lines", "\n\nbuild-note: handed off"],
		["a fabrika HTML comment", "<!-- fabrika-triage-claim session=s -->\nclaimed"],
		["an ac HTML comment below prose", "Appended.\n<!-- ac:review -->"],
		["a hyphenless gate verdict", "review: PASS @ a1b2c3d — criteria met"],
	])("reads %s as a marker", (_, body) => {
		expect(carriesMachineMarker(body)).toBe(true);
	});

	it.each([
		["free prose", "Use `base * 3` instead."],
		["a hyphenless key that is no verdict", "note: this is a person writing"],
		["a hyphenated key below the first line", "My view.\nbuild-claim: quoted from above"],
		["an empty body", ""],
	])("reads %s as no marker", (_, body) => {
		expect(carriesMachineMarker(body)).toBe(false);
	});
});
