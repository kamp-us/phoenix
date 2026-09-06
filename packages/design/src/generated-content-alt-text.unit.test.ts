// Generated content is folded into a name-from-content computation by design, so a `::before` or
// `::after` string on an element whose name comes from its children corrupts that name — the active
// palette row was named "› Effect nedir? …" and renamed on every arrow keypress (#8079). ADR 0166
// §8 makes staying out of the name a condition of a state marker's lawfulness, and this test is the
// only place it can be checked: jsdom leaves `computedStyleSupportsPseudoElements` off, so no
// rendered test in this repo ever evaluates pseudo-element content.
import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const sourceRoots = [
	join(repoRoot, "apps/web/src"),
	join(repoRoot, "apps/tuval/src"),
	join(repoRoot, "packages/design/src"),
];

function stylesheets(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return stylesheets(path);
		return entry.name.endsWith(".css") ? [path] : [];
	});
}

/** A `content:` value carrying no rendered text — nothing for accname to fold in. */
const rendersNoText = (value: string): boolean =>
	value === "none" || value === "normal" || /^(""|'')$/.test(value);

/** The CSS Content Level 3 alternative-text form: everything after `/` is what AT reads. */
const carriesAltText = (value: string): boolean => /\/\s*("[^"]*"|'[^']*')\s*$/.test(value);

type Finding = {file: string; selector: string; value: string};

function leaks(): Finding[] {
	return sourceRoots.flatMap((root) =>
		stylesheets(root).flatMap((path) => {
			const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

			return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) => {
				const selector = (rule[1] ?? "").trim();
				if (!/::?(before|after)\b/.test(selector)) return [];

				const declaration = /(?:^|;)\s*content\s*:([^;]*)/.exec(rule[2] ?? "");
				const value = declaration?.[1]?.trim();
				if (value === undefined || rendersNoText(value) || carriesAltText(value)) return [];

				return [{file: relative(repoRoot, path), selector, value}];
			});
		}),
	);
}

describe("generated content", () => {
	it("never reaches an accessible name without alternative text", () => {
		expect(leaks()).toEqual([]);
	});

	it("scans a non-empty corpus", () => {
		expect(sourceRoots.flatMap(stylesheets).length).toBeGreaterThan(0);
	});
});
