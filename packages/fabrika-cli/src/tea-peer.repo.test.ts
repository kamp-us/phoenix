/**
 * The drift guard behind fabrika-cli's `@demlik/tea` pin.
 *
 * fabrika-cli ships with tea as a hard dependency, and tea declares an optional `vitest` peer. When
 * that range excludes the vitest adopters run, every `pnpm install` of the CLI warns and npm 11
 * refuses with ERESOLVE — which is how 0.12.0's `^2 || ^3` sat under every vitest 4 and 5 repo. This
 * reads the two installed manifests, with no network, and reds when the pinned tea's range stops
 * admitting the vitest this workspace installs.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {type Admission, admits} from "./peer-range.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Manifest {
	readonly version?: string;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

const installed = (name: string): Manifest =>
	JSON.parse(readFileSync(join(PACKAGE_ROOT, "node_modules", name, "package.json"), "utf8"));

/** tea's `vitest` peer against vitest's own version — a tea with no such peer admits anything. */
const teaAdmitsVitest = (tea: Manifest, vitest: Manifest): Admission => {
	const range = tea.peerDependencies?.vitest;
	if (range === undefined) return {_tag: "Admits"};
	if (vitest.version === undefined)
		return {_tag: "Unreadable", reason: "vitest's package.json names no version"};
	return admits(range, vitest.version);
};

describe("@demlik/tea's vitest peer", () => {
	it("admits the vitest this workspace installs", () => {
		expect(teaAdmitsVitest(installed("@demlik/tea"), installed("vitest"))).toEqual({
			_tag: "Admits",
		});
	});

	it("reds on tea 0.12.0's range, the one that excluded vitest 4 and 5", () => {
		const tea012: Manifest = {version: "0.12.0", peerDependencies: {vitest: "^2 || ^3"}};

		expect(teaAdmitsVitest(tea012, installed("vitest"))).toMatchObject({_tag: "Excludes"});
		expect(teaAdmitsVitest(tea012, {version: "5.0.1"})).toMatchObject({_tag: "Excludes"});
	});
});

describe("admits", () => {
	it.each([
		["^2 || ^3 || ^4 || ^5", "4.1.11"],
		["^2 || ^3 || ^4 || ^5", "5.0.1"],
		["^4.1.5", "4.9.0"],
		["~4.1.5", "4.1.9"],
		["4", "4.2.0"],
		["4.1.11", "4.1.11"],
		["^0.12.0", "0.12.3"],
		["*", "9.0.0"],
	])("%s admits %s", (range, version) => {
		expect(admits(range, version)).toEqual({_tag: "Admits"});
	});

	it.each([
		["^2 || ^3", "4.1.11"],
		["^4.1.5", "4.1.4"],
		["^4.1.5", "5.0.0"],
		["~4.1.5", "4.2.0"],
		["^0.12.0", "0.13.0"],
		["^0.0.3", "0.0.4"],
		["^5", "5.0.0-beta.1"],
	])("%s excludes %s", (range, version) => {
		expect(admits(range, version)).toMatchObject({_tag: "Excludes"});
	});

	it("reads a comparator it does not know as unreadable, never as a pass", () => {
		expect(admits(">=4 <6", "5.0.0")).toMatchObject({_tag: "Unreadable"});
		expect(admits("^4", "not-a-version")).toMatchObject({_tag: "Unreadable"});
	});
});
