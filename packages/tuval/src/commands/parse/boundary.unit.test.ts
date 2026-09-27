/**
 * The boundary this module keeps: it is pure, so the page and the kernel can both run it. Nothing
 * here reaches React, the DOM, the process table or the shell — the snapshot it reads is the
 * protocol's, and that is its whole view of live state.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
	["react", /^react(\/|$)|^react-dom(\/|$)/],
	["the DOM", /^dom($|\/)|(^|\/)jsdom(\/|$)/],
	["src/process/", /(^|\/)process(\/|$)/],
	["src/shell/", /(^|\/)shell(\/|$)/],
];

describe("src/commands/parse boundary", () => {
	it("imports nothing from React, the DOM, src/process/ or src/shell/", () => {
		const directory = import.meta.dirname;
		const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
		// Fail closed: an empty scope would pass this assertion for the wrong reason.
		expect(files.length).toBeGreaterThan(0);

		const offenders = files.flatMap((name) => {
			const source = readFileSync(join(directory, name), "utf8");
			const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
			return specifiers.flatMap((specifier) =>
				FORBIDDEN.filter(([, pattern]) => pattern.test(specifier)).map(
					([label]) => `${name}: ${specifier} (${label})`,
				),
			);
		});
		expect(offenders).toEqual([]);
	});
});
