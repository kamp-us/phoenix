import {describe, expect, it} from "vitest";
import {BUILD_CLAIM, composeMarker, readMarkerToken} from "../build/claim.ts";
import {claimTarget, LANE_CLAIM} from "./claim.ts";
import {parseKey} from "./key.ts";

const key = (raw: string) => {
	const parsed = parseKey(raw);
	if (parsed._tag === "Malformed") throw new Error(`fixture key "${raw}" is malformed`);
	return parsed.key;
};

describe("LANE_CLAIM", () => {
	it("reads its own markers and is blind to a build claim's", () => {
		const driver = composeMarker(
			"lane:s-1:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d",
			"at",
			null,
			LANE_CLAIM,
		);
		expect(readMarkerToken(driver, LANE_CLAIM)).toBe(
			"lane:s-1:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d",
		);
		expect(readMarkerToken(driver, BUILD_CLAIM)).toBeNull();
	});

	it("is invisible to the build namespace, so a driver never locks out its own builder", () => {
		const builder = composeMarker("build:s-2:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d", "at");
		expect(readMarkerToken(builder, BUILD_CLAIM)).toBe(
			"build:s-2:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d",
		);
		expect(readMarkerToken(builder, LANE_CLAIM)).toBeNull();
	});

	it("refuses a token whose prefix belongs to the other namespace", () => {
		const crossed = "lane-claim: build:s-1:c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d · at";
		expect(readMarkerToken(crossed, LANE_CLAIM)).toBeNull();
	});
});

describe("claimTarget", () => {
	it("races on the board number an issue lane is keyed by", () => {
		expect(claimTarget(key("5492"))).toEqual({_tag: "Number", number: 5492});
	});

	it("is inert on a chore lane — no board number, so no thread to race on", () => {
		const target = claimTarget(key("chore:park-sweep"));
		expect(target._tag).toBe("Inert");
	});

	it("is inert on a key that is not a board number, rather than racing on a guess", () => {
		expect(claimTarget(key("epic-5492"))._tag).toBe("Inert");
		expect(claimTarget(key("0"))._tag).toBe("Inert");
	});
});
