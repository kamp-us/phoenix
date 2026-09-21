/**
 * The optional-`__BOOT__` client contract (ADR 0179 §4). Runs in the node unit tier where `window`
 * is undefined by default — the exact absence the contract must tolerate; the present-payload
 * cases set a stub `window` and restore it.
 */
import {afterEach, describe, expect, it} from "vitest";
import type {BootPayload} from "./boot.ts";
import {readBoot, readBootUser} from "./boot.ts";
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
		const payload: BootPayload = {user: null};
		withBoot(payload);
		expect(readBoot()).toEqual(payload);
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
		withBoot({user: bootUser});
		expect(readBootUser()).toEqual(bootUser);
	});

	it("returns null for a signed-out viewer (user explicitly null)", () => {
		withBoot({user: null});
		expect(readBootUser()).toBeNull();
	});

	it("returns null when __BOOT__ is absent (never-hang fallback / flag off) — the async fallback", () => {
		expect(readBootUser()).toBeNull();
		withBoot({});
		expect(readBootUser()).toBeNull();
	});
});
