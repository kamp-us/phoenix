import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {faultingShell} from "../fakes.test-support.ts";
import type {LocalInstall} from "./discover.ts";
import {DELEGATED_ENV, resolve, spawnDelegate, traceLine} from "./resolve.ts";

const local: LocalInstall = {
	packageRoot: "/repo/packages/fabrika-cli",
	manifestPath: "/repo/node_modules/@kampus/fabrika-cli/package.json",
	binPath: "/repo/packages/fabrika-cli/dist/bin.js",
};

describe("resolve", () => {
	it("delegates to the repo-local install — the pinned version wins over the global", () => {
		const resolution = resolve({
			selfPackageRoot: "/usr/local/pnpm/global/5/node_modules/@kampus/fabrika-cli",
			found: local,
			alreadyDelegated: false,
		});
		expect(resolution).toEqual({_tag: "delegate", to: local});
	});

	it("runs here when the walk found nothing — the global is a real install, not a fallback", () => {
		const resolution = resolve({
			selfPackageRoot: "/global/@kampus/fabrika-cli",
			found: undefined,
			alreadyDelegated: false,
		});
		expect(resolution._tag).toBe("run-here");
	});

	it("runs here when the install it found IS this copy, rather than spawning itself", () => {
		const resolution = resolve({
			selfPackageRoot: local.packageRoot,
			found: local,
			alreadyDelegated: false,
		});
		expect(resolution._tag).toBe("run-here");
	});

	it(`stops at one hop: a child stamped with ${DELEGATED_ENV} never delegates again`, () => {
		const resolution = resolve({
			selfPackageRoot: "/somewhere/else",
			found: local,
			alreadyDelegated: true,
		});
		expect(resolution._tag).toBe("run-here");
	});
});

describe("traceLine", () => {
	it("names both copies on a delegation, so the hop is checkable from outside", () => {
		const line = traceLine(
			"/global/@kampus/fabrika-cli",
			resolve({
				selfPackageRoot: "/global/@kampus/fabrika-cli",
				found: local,
				alreadyDelegated: false,
			}),
		);
		expect(line).toContain("/global/@kampus/fabrika-cli");
		expect(line).toContain(local.packageRoot);
		expect(line).toContain(local.binPath);
	});

	it("says why it stayed put, not merely that it did", () => {
		const line = traceLine(
			"/global/@kampus/fabrika-cli",
			resolve({
				selfPackageRoot: "/global/@kampus/fabrika-cli",
				found: undefined,
				alreadyDelegated: false,
			}),
		);
		expect(line).toContain("no repo-local install above the cwd");
	});
});

describe("spawnDelegate", () => {
	it("answers 2 — not the child's verdict — when the spawn itself faults", async () => {
		const code = await Effect.runPromise(
			spawnDelegate({
				execPath: "/usr/bin/node",
				binPath: local.binPath,
				args: ["adr", "next"],
				cwd: "/repo",
			}).pipe(Effect.provide(faultingShell)),
		);
		expect(code).toBe(2);
	});
});
