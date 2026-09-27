/**
 * The fail-closed drift check for the shell-key manifest (ADR 0179 §3). Deliberately an in-app
 * unit test, NOT a CI guard, so this slice stays NON-§CP (#2928).
 */
import {describe, expect, it} from "vitest";
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	SHELL_FLAG_KEYS,
	ShellKeyDriftError,
} from "./shell-keys";

describe("shell-key manifest — the geometry-law member set", () => {
	it("names exactly the shell-critical flag keys", () => {
		expect([...SHELL_FLAG_KEYS]).toEqual([]);
	});

	it("the __BOOT__ boolean-member keys are exactly the flag keys — the user is not a member key", () => {
		expect([...BOOT_MEMBER_KEYS]).toEqual([...SHELL_FLAG_KEYS]);
		expect([...BOOT_MEMBER_KEYS]).not.toContain("signedIn");
		expect([...BOOT_MEMBER_KEYS]).not.toContain("user");
	});
});

describe("assertShellBootKeysSingleSourced — fail-closed single-source guard", () => {
	const canonical = [...BOOT_MEMBER_KEYS];

	it("accepts when the worker-injected and client-consumed sets both derive from the manifest", () => {
		expect(() => assertShellBootKeysSingleSourced(canonical, canonical)).not.toThrow();
	});

	it("FAILS when the worker injects a flag absent from the empty manifest", () => {
		expect(() => assertShellBootKeysSingleSourced(["phoenix-rogue-key"], canonical)).toThrow(
			ShellKeyDriftError,
		);
	});

	it("FAILS when the client consumption adds a key the manifest does not name (client-side drift)", () => {
		const consumedWithExtra = [...canonical, "phoenix-not-a-shell-key"];
		expect(() => assertShellBootKeysSingleSourced(canonical, consumedWithExtra)).toThrow(
			ShellKeyDriftError,
		);
	});

	it("names the drifting side and the missing/extra keys in the error", () => {
		try {
			assertShellBootKeysSingleSourced(["phoenix-rogue-key"], canonical);
			expect.unreachable("expected a ShellKeyDriftError");
		} catch (err) {
			expect(err).toBeInstanceOf(ShellKeyDriftError);
			const drift = err as ShellKeyDriftError;
			expect(drift.side).toContain("worker");
			expect(drift.missing).toEqual([]);
			expect(drift.extra).toEqual(["phoenix-rogue-key"]);
		}
	});
});
