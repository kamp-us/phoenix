/**
 * Pins the shared Sentry flag-attribution naming contract (#1821): a resolved flag maps to
 * `flag.<key>` = `on`/`off`, so the #1822 graduation query is `flag.<key>:on`. One definition
 * feeds both the SPA tagger (`src/lib/sentry.ts`) and the worker tagger (`worker/lib/sentry.ts`),
 * so this is the single place the shape is proven — both tiers inherit it and cannot drift.
 */
import {describe, expect, it} from "vitest";
import {FLAG_TAG_PREFIX, flagTag} from "./flag-tag.ts";

describe("flagTag — the shared flag.<key>:on/off contract", () => {
	it("maps a resolved-on flag to flag.<key> = on", () => {
		expect(flagTag("phoenix-bildirim", true)).toEqual({
			tagKey: "flag.phoenix-bildirim",
			tagValue: "on",
		});
	});

	it("maps a resolved-off flag to flag.<key> = off", () => {
		expect(flagTag("pano-optimistic-comment-add", false)).toEqual({
			tagKey: "flag.pano-optimistic-comment-add",
			tagValue: "off",
		});
	});

	it("namespaces every key under the flag. prefix", () => {
		expect(FLAG_TAG_PREFIX).toBe("flag.");
		expect(flagTag("any-key", true).tagKey.startsWith(FLAG_TAG_PREFIX)).toBe(true);
	});
});
