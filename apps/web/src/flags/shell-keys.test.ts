/**
 * The fail-closed drift check for the shell-key manifest (#2928, ADR 0179 §3): the worker
 * injects `window.__BOOT__` and the client reads it, and this proves BOTH key sets derive
 * from the one manifest — a divergence throws. Deliberately an in-app unit test, NOT a
 * `pipeline-cli` CI guard, so this slice stays NON-§CP (#2928).
 */
import {describe, expect, it} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ} from "./keys";
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	SHELL_FLAG_KEYS,
	ShellKeyDriftError,
} from "./shell-keys";

describe("shell-key manifest — the geometry-law member set", () => {
	it("names exactly the shell-critical flag keys", () => {
		expect([...SHELL_FLAG_KEYS]).toEqual([MECMUA_PUBLIC_READ, MECMUA_FEED]);
		expect([...SHELL_FLAG_KEYS]).toEqual(["mecmua-public-read", "mecmua-feed"]);
	});

	it("the __BOOT__ boolean-member keys are exactly the flag keys — the user is not a member key", () => {
		// ADR 0185 superseded #2933's `signedIn` presence bit with the typed `user` object, so the
		// boolean member set carries the shell flags and nothing else; `user` is a distinct field.
		expect([...BOOT_MEMBER_KEYS]).toEqual([...SHELL_FLAG_KEYS]);
		expect([...BOOT_MEMBER_KEYS]).not.toContain("signedIn");
		expect([...BOOT_MEMBER_KEYS]).not.toContain("user");
	});
});

describe("assertShellBootKeysSingleSourced — fail-closed single-source guard", () => {
	// The seam both sides derive from the manifest: the worker injects BOOT_MEMBER_KEYS, the
	// client reads BOOT_MEMBER_KEYS — the shared-source case the guard must accept.
	const canonical = [...BOOT_MEMBER_KEYS];

	it("accepts when the worker-injected and client-consumed sets both derive from the manifest", () => {
		expect(() => assertShellBootKeysSingleSourced(canonical, canonical)).not.toThrow();
	});

	it("accepts regardless of key ordering (a set, not a sequence)", () => {
		expect(() =>
			assertShellBootKeysSingleSourced(canonical, [...canonical].reverse()),
		).not.toThrow();
	});

	it("FAILS when the worker injection omits a manifest key (worker-side drift)", () => {
		const injectedMissingFeed = canonical.filter((k) => k !== MECMUA_FEED);
		expect(() => assertShellBootKeysSingleSourced(injectedMissingFeed, canonical)).toThrow(
			ShellKeyDriftError,
		);
	});

	it("FAILS when the client consumption adds a key the manifest does not name (client-side drift)", () => {
		const consumedWithExtra = [...canonical, "phoenix-not-a-shell-key"];
		expect(() => assertShellBootKeysSingleSourced(canonical, consumedWithExtra)).toThrow(
			ShellKeyDriftError,
		);
	});

	it("FAILS when the client omits a manifest flag key (client-side drift)", () => {
		const consumedMissingFeed = canonical.filter((k) => k !== MECMUA_FEED);
		expect(() => assertShellBootKeysSingleSourced(canonical, consumedMissingFeed)).toThrow(
			ShellKeyDriftError,
		);
	});

	it("names the drifting side and the missing/extra keys in the error", () => {
		try {
			assertShellBootKeysSingleSourced(
				canonical.filter((k) => k !== MECMUA_PUBLIC_READ),
				canonical,
			);
			expect.unreachable("expected a ShellKeyDriftError");
		} catch (err) {
			expect(err).toBeInstanceOf(ShellKeyDriftError);
			const drift = err as ShellKeyDriftError;
			expect(drift.side).toContain("worker");
			expect(drift.missing).toContain(MECMUA_PUBLIC_READ);
			expect(drift.extra).toEqual([]);
		}
	});
});
