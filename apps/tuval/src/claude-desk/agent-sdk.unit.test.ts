/**
 * The Claude Agent SDK is `@kampus/tuval-claude`'s dependency, and the desk reaches Claude only
 * through that package's doors (#9655). So no module of the app names an `@anthropic-ai/` specifier,
 * and the app's manifest lists none: the harness package is the one place the vendor SDK comes in.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const appRoot = join(import.meta.dirname, "..", "..");

const isSource = (entry: string): boolean => entry.endsWith(".ts") || entry.endsWith(".tsx");

const sourcesUnder = (dir: string): ReadonlyArray<{name: string; text: string}> =>
	readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		return isSource(entry) ? [{name: path, text: readFileSync(path, "utf8")}] : [];
	});

const specifiersOf = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

describe("the Claude Agent SDK stays in @kampus/tuval-claude", () => {
	it("is named by no module of the app", () => {
		const roots = ["src", ".tuval", "test-consumer"].map((dir) => join(appRoot, dir));
		const scanned = roots.flatMap(sourcesUnder);
		expect(scanned.length).toBeGreaterThan(100);
		const offenders = scanned.flatMap(({name, text}) =>
			specifiersOf(text)
				.filter((specifier) => specifier.startsWith("@anthropic-ai/"))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("is listed in none of the app's dependency blocks", () => {
		const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const listed = ["dependencies", "devDependencies", "peerDependencies"].flatMap((block) =>
			Object.keys((manifest[block] as Record<string, string> | undefined) ?? {}),
		);
		expect(listed).toContain("@kampus/tuval-claude");
		expect(listed.filter((name) => name.startsWith("@anthropic-ai/"))).toEqual([]);
	});
});
