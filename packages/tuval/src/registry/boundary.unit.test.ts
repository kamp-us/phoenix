/**
 * The boundary this slice keeps: nothing under `src/registry/` imports `src/host/`. The slice
 * describes a program and never runs one (the founder's 2026-09-05 ruling on #7933).
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

describe("registry boundary", () => {
	it("nothing in src/registry/ imports from src/host/", () => {
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers.filter((s) => /(^|\/)host(\/|$)/.test(s)).map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
