/**
 * The boundary this program keeps: the order, the columns, the state and the attach address are
 * plain data, so only the `.tsx` files may reach React or the DOM. Keeping the pure half free of
 * both is what lets the ordering and sorting be tested with no jsdom at all — and it is what stops a
 * later renderer change from quietly moving domain logic into a component.
 *
 * Nothing here may reach a socket, `node:*`, or the kernel-side slices either: this program's whole
 * input is `Snapshot.processes` (founder ruling 2), and an import of `../../table/ProcessTablePort`
 * or `../../process/` would be a second source of process facts.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const dir = import.meta.dirname;

const sourceFiles = (extension: string): ReadonlyArray<string> =>
	readdirSync(dir).filter(
		(name) => name.endsWith(extension) && !name.includes(".unit.test.") && name !== "fixtures.ts",
	);

const specifiersIn = (name: string): ReadonlyArray<string> =>
	[...readFileSync(join(dir, name), "utf8").matchAll(/from\s+"([^"]+)"|import\s+"([^"]+)"/g)].map(
		(match) => match[1] ?? match[2] ?? "",
	);

describe("ps boundary", () => {
	it("keeps React and the DOM out of the pure half", () => {
		const offenders = sourceFiles(".ts").flatMap((name) =>
			specifiersIn(name)
				.filter((specifier) => /^react/.test(specifier) || specifier.endsWith(".css"))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("reads no second source of process facts, and no socket or node builtin", () => {
		const forbidden = [
			/^node:/,
			/^ws$/,
			/\.\.\/\.\.\/process\//,
			/\.\.\/\.\.\/table\/ProcessTablePort/,
			/\.\.\/\.\.\/shell\/transport\//,
		];
		const offenders = [...sourceFiles(".ts"), ...sourceFiles(".tsx")].flatMap((name) =>
			specifiersIn(name)
				.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("touches no `document` or `window` global outside the components", () => {
		const offenders = sourceFiles(".ts").filter((name) =>
			/\b(document|globalThis)\s*\./.test(readFileSync(join(dir, name), "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
