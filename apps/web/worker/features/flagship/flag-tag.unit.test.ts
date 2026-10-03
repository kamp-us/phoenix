/**
 * Pins the Sentry flag-attribution naming contract: `flag.<key>` = `on`/`off`, so the
 * graduation query is `flag.<key>:on`. One definition feeds both the SPA and worker
 * taggers, so proving it here is what stops the two drifting.
 */
import {describe, expect, it} from "vitest";
import {flagTag} from "./flag-tag.ts";

describe("flagTag — the shared flag.<key>:on/off contract", () => {
	it("maps a resolved-on flag to flag.<key> = on", () => {
		expect(flagTag("phoenix-bildirim", true)).toEqual({
			tagKey: "flag.phoenix-bildirim",
			tagValue: "on",
		});
	});

	it("maps a resolved-off flag to flag.<key> = off", () => {
		expect(flagTag("member-mute", false)).toEqual({
			tagKey: "flag.member-mute",
			tagValue: "off",
		});
	});
});
