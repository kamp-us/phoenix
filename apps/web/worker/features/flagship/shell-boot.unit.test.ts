/**
 * Unit coverage for the edge-render pure core (#2929, ADR 0179): the `window.__BOOT__`
 * payload shape, the inline-script serialization, and the single-source drift guard the
 * inject seam calls. `injectBootScript`'s `HTMLRewriter` streaming is a workerd global,
 * exercised in the integration tier — not here.
 */
import {describe, expect, it} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, PHOENIX_NAV_IA} from "../../../src/flags/keys.ts";
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	SHELL_SIGNED_IN_KEY,
	ShellKeyDriftError,
} from "../../../src/flags/shell-keys.ts";
import {bootScriptTag, buildBootPayload} from "./shell-boot.ts";

const shellFlags = {
	[PHOENIX_NAV_IA]: true,
	[MECMUA_PUBLIC_READ]: false,
	[MECMUA_FEED]: true,
} as const;

describe("buildBootPayload", () => {
	it("carries every shell flag value plus the signedIn presence bit", () => {
		const payload = buildBootPayload(true, shellFlags);
		expect(payload[PHOENIX_NAV_IA]).toBe(true);
		expect(payload[MECMUA_PUBLIC_READ]).toBe(false);
		expect(payload[MECMUA_FEED]).toBe(true);
		expect(payload[SHELL_SIGNED_IN_KEY]).toBe(true);
	});

	it("sets signedIn from the session presence, independent of the flags", () => {
		expect(buildBootPayload(false, shellFlags)[SHELL_SIGNED_IN_KEY]).toBe(false);
	});

	it("produces exactly the manifest key set (no injected/manifest drift)", () => {
		const keys = Object.keys(buildBootPayload(true, shellFlags));
		expect([...keys].sort()).toEqual([...BOOT_MEMBER_KEYS].sort());
		// The seam the worker actually calls before injecting — proven to pass for our payload.
		expect(() => assertShellBootKeysSingleSourced(keys, [...BOOT_MEMBER_KEYS])).not.toThrow();
	});
});

describe("bootScriptTag", () => {
	it("seeds window.__BOOT__ with the JSON payload, parseable back to the payload", () => {
		const payload = buildBootPayload(true, shellFlags);
		const tag = bootScriptTag(payload);
		expect(tag.startsWith("<script>window.__BOOT__=")).toBe(true);
		expect(tag.endsWith("</script>")).toBe(true);
		const json = tag.slice("<script>window.__BOOT__=".length, -"</script>".length);
		expect(JSON.parse(json)).toEqual(payload);
	});

	it("escapes `<` so a payload can never break out of the script tag", () => {
		// Values are boolean today, so force a `<`-bearing key through the serializer to prove
		// the XSS-safe escape (`<` -> <) is applied — no raw `<` survives in the JSON body.
		const tag = bootScriptTag({"</script><x": true} as never);
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
