/**
 * The package is a harness built on the public SDK like any outside program (#9657): it reaches
 * `@kampus/tuval-sdk` and `@kampus/tuval-ui` through their exports maps, never the desk app, and
 * never out of its own root by relative path.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const specifiersOf = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

const isSource = (entry: string): boolean => entry.endsWith(".ts") || entry.endsWith(".tsx");

const sourcesUnder = (dir: string): ReadonlyArray<{name: string; text: string}> =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		return isSource(entry) ? [{name: path, text: readFileSync(path, "utf8")}] : [];
	});

describe("what the package reaches", () => {
	const root = join(import.meta.dirname, "..");
	const sources = sourcesUnder(import.meta.dirname);
	const resolveFromHere = createRequire(import.meta.url).resolve;

	it("names no app package and no relative path out of its root", () => {
		expect(sources.length).toBeGreaterThan(20);
		const offenders = sources.flatMap(({name, text}) =>
			specifiersOf(text)
				.filter(
					(specifier) =>
						specifier.startsWith("@kampus-apps/") ||
						(specifier.startsWith(".") &&
							relative(root, join(dirname(name), specifier)).startsWith("..")),
				)
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("reaches the SDK and the UI package only through doors their exports maps declare", () => {
		const specifiers = [
			...new Set(
				sources.flatMap(({text}) =>
					specifiersOf(text).filter(
						(specifier) =>
							specifier.startsWith("@kampus/tuval-sdk") || specifier.startsWith("@kampus/tuval-ui"),
					),
				),
			),
		];
		expect(specifiers.length).toBeGreaterThan(0);
		// `resolve` walks the target's `exports` map, so a specifier naming a file no door opens
		// throws `ERR_PACKAGE_PATH_NOT_EXPORTED` here exactly as it would for an outside consumer.
		for (const specifier of specifiers) {
			expect(() => resolveFromHere(specifier), specifier).not.toThrow();
		}
	});
});
