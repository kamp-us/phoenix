/**
 * Unit coverage for the edge-render pure core (#2929, ADR 0179; #3030/ADR 0185 for the `user`
 * field): the `window.__BOOT__` payload shape, the inline-script serialization, and the
 * single-source drift guard the inject seam calls. `injectBootScript`'s `HTMLRewriter` streaming
 * is a workerd global, exercised in the integration tier — not here.
 */
import {describe, expect, it} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, PHOENIX_NAV_IA} from "../../../src/flags/keys.ts";
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	type BootUser,
	ShellKeyDriftError,
} from "../../../src/flags/shell-keys.ts";
import {bootScriptTag, buildBootPayload} from "./shell-boot.ts";

const shellFlags = {
	[PHOENIX_NAV_IA]: true,
	[MECMUA_PUBLIC_READ]: false,
	[MECMUA_FEED]: true,
} as const;

// The edge-resolved current user (`__BOOT__.user`, ADR 0185) — the exact `BootUser` shape the
// client `useMe` seeds from, carrying the trusted tier + moderator standing.
const bootUser: BootUser = {
	id: "user-42",
	email: "elif@kamp.us",
	name: "Elif",
	image: null,
	username: "elif",
	tier: "yazar",
	isModerator: false,
	emailFailing: false,
};

describe("buildBootPayload", () => {
	it("carries every shell flag value plus the edge-resolved user object", () => {
		const payload = buildBootPayload(bootUser, shellFlags);
		expect(payload[PHOENIX_NAV_IA]).toBe(true);
		expect(payload[MECMUA_PUBLIC_READ]).toBe(false);
		expect(payload[MECMUA_FEED]).toBe(true);
		expect(payload.user).toEqual(bootUser);
	});

	it("sets user to null for a signed-out viewer, independent of the flags", () => {
		expect(buildBootPayload(null, shellFlags).user).toBeNull();
	});

	it("the boolean flag members are exactly the manifest key set — `user` is not a member key", () => {
		const flagKeys = Object.keys(buildBootPayload(bootUser, shellFlags)).filter(
			(k) => k !== "user",
		);
		expect([...flagKeys].sort()).toEqual([...BOOT_MEMBER_KEYS].sort());
		expect(BOOT_MEMBER_KEYS).not.toContain("user");
		// The seam the worker actually calls before injecting — proven to pass for our flag keys.
		expect(() => assertShellBootKeysSingleSourced(flagKeys, [...BOOT_MEMBER_KEYS])).not.toThrow();
	});
});

describe("bootScriptTag", () => {
	it("seeds window.__BOOT__ with the JSON payload (flags + user), parseable back to the payload", () => {
		const payload = buildBootPayload(bootUser, shellFlags);
		const tag = bootScriptTag(payload);
		expect(tag.startsWith("<script>window.__BOOT__=")).toBe(true);
		expect(tag.endsWith("</script>")).toBe(true);
		const json = tag.slice("<script>window.__BOOT__=".length, -"</script>".length);
		expect(JSON.parse(json)).toEqual(payload);
		expect(JSON.parse(json).user).toEqual(bootUser);
	});

	it("escapes `<` so a payload can never break out of the script tag", () => {
		// A `<`-bearing user field (e.g. an attacker display name) must not survive raw in the JSON
		// body — the escape (`<` -> <) is what keeps the injected object XSS-safe.
		const tag = bootScriptTag(
			buildBootPayload({...bootUser, name: "</script><script>evil"}, shellFlags),
		);
		const body = tag.slice("<script>window.__BOOT__=".length, -"</script>".length);
		expect(body).not.toContain("<");
		expect(body).toContain("\\u003c");
	});
});

describe("assertShellBootKeysSingleSourced (the inject-seam guard the route calls)", () => {
	it("throws ShellKeyDriftError when the injected key set drifts from the manifest", () => {
		const drifted = [...BOOT_MEMBER_KEYS, "phoenix-rogue-key"];
		expect(() => assertShellBootKeysSingleSourced(drifted, [...BOOT_MEMBER_KEYS])).toThrow(
			ShellKeyDriftError,
		);
	});
});
