/**
 * The optional-`__BOOT__` client contract (#2931, ADR 0179 §4): the shell renders correctly when
 * `window.__BOOT__` is ABSENT — the never-hang outage fallback or a flag-off render served the
 * untransformed asset — by resolving to `undefined` so the caller falls back to its fetch path,
 * never assuming injection happened. Runs in the node unit tier where `window` is undefined by
 * default (the exact absence the contract must tolerate); the present-payload cases set a stub
 * `window` and restore it.
 */
import {afterEach, describe, expect, it} from "vitest";
import type {BootPayload} from "./boot.ts";
import {readBoot, readBootMember, readBootUser} from "./boot.ts";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, PHOENIX_NAV_IA} from "./keys.ts";
import type {BootUser} from "./shell-keys.ts";

const withBoot = (boot: unknown) => {
	(globalThis as {window?: unknown}).window = {__BOOT__: boot};
};

afterEach(() => {
	delete (globalThis as {window?: unknown}).window;
});

describe("readBoot — absent __BOOT__ is a first-class, non-error state", () => {
	it("returns undefined when there is no window (outage fallback / flag off) — no throw", () => {
		expect(readBoot()).toBeUndefined();
	});

	it("returns undefined when window exists but __BOOT__ was never injected", () => {
		(globalThis as {window?: unknown}).window = {};
		expect(readBoot()).toBeUndefined();
	});

	it("returns undefined when __BOOT__ is not a well-formed object", () => {
		withBoot("not-an-object");
		expect(readBoot()).toBeUndefined();
		withBoot(null);
		expect(readBoot()).toBeUndefined();
	});

	it("returns the injected payload when the edge injected a well-formed object", () => {
		const payload: BootPayload = {[MECMUA_PUBLIC_READ]: true, [MECMUA_FEED]: false};
		withBoot(payload);
		expect(readBoot()).toEqual(payload);
	});
});

describe("readBootMember — a member key falls back to the fetch path unless truly present", () => {
	it("returns undefined for every member when __BOOT__ is absent (the fetch-fallback signal)", () => {
		expect(readBootMember(MECMUA_PUBLIC_READ)).toBeUndefined();
		expect(readBootMember(MECMUA_FEED)).toBeUndefined();
	});

	it("returns the injected boolean when the key is present", () => {
		withBoot({[MECMUA_PUBLIC_READ]: true, [MECMUA_FEED]: true});
		expect(readBootMember(MECMUA_PUBLIC_READ)).toBe(true);
		expect(readBootMember(MECMUA_FEED)).toBe(true);
	});

	it("returns undefined for a key absent from an otherwise-present payload", () => {
		withBoot({[MECMUA_PUBLIC_READ]: true});
		expect(readBootMember(PHOENIX_NAV_IA)).toBeUndefined();
	});

	it("returns undefined for a non-boolean value rather than fabricating a gate", () => {
		withBoot({[MECMUA_PUBLIC_READ]: "true"});
		expect(readBootMember(MECMUA_PUBLIC_READ)).toBeUndefined();
	});
});

describe("readBootUser — the synchronous first-paint identity (ADR 0185)", () => {
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

	it("returns the injected user object when the edge resolved a signed-in viewer", () => {
		withBoot({[MECMUA_PUBLIC_READ]: true, user: bootUser});
		expect(readBootUser()).toEqual(bootUser);
	});

	it("returns null for a signed-out viewer (user explicitly null)", () => {
		withBoot({[MECMUA_PUBLIC_READ]: true, user: null});
		expect(readBootUser()).toBeNull();
	});

	it("returns null when __BOOT__ is absent (never-hang fallback / flag off) — the async fallback", () => {
		expect(readBootUser()).toBeNull();
		withBoot({[MECMUA_PUBLIC_READ]: true});
		expect(readBootUser()).toBeNull();
	});
});
