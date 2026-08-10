import {describe, expect, it} from "vitest";
import {packNonce} from "../wire/handoff-pack.ts";
import {NONCE} from "./fixtures.test-support.ts";
import {composeClaimMarker, instant, reachesForClaim, readClaimMarker, stampOf} from "./markers.ts";

const nonce = packNonce(NONCE);
const at = instant("2026-08-09T19:02:11Z");
if (nonce === null || at === null) throw new Error("fixture does not conform");

describe("the claim marker", () => {
	const line = composeClaimMarker({nonce, packComment: 9234567891, claimedAt: at});

	it("round-trips, keyed on the run nonce and naming the pack comment it claims", () => {
		expect(readClaimMarker(line)).toEqual({
			nonce: NONCE,
			packComment: 9234567891,
			claimedAt: "2026-08-09T19:02:11Z",
		});
	});

	it("is not a pack marker, and a pack marker is not a claim", () => {
		expect(reachesForClaim(line)).toBe(true);
		expect(reachesForClaim("<!-- fabrika:handoff pack nonce=7f3a9c21 -->")).toBe(false);
	});

	it("refuses a near-miss rather than tolerating it", () => {
		expect(readClaimMarker(line.replace("nonce=7f3a9c21", "nonce=run-1"))).toBeNull();
		expect(readClaimMarker(line.replace("packComment=9234567891", "pack=9234567891"))).toBeNull();
		expect(readClaimMarker("just a comment")).toBeNull();
	});

	it("stamps seconds-precision UTC, which is what the marker grammar admits", () => {
		expect(stampOf(new Date("2026-08-09T19:02:11.482Z"))).toBe("2026-08-09T19:02:11Z");
	});
});
