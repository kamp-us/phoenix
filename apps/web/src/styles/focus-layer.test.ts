/**
 * The focus ring is painted ONCE, in `global.css` (#2169). These pin that
 * single source: a bespoke per-component `outline: var(--focus-ring)` (or the
 * pre-#2169 divergent `outline: 2px solid var(--accent)`) fails here rather than
 * only under manual review.
 */
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const SRC = join(import.meta.dirname, "..");
const GLOBAL_CSS = join(SRC, "styles", "global.css");

function cssFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...cssFiles(p));
		else if (entry.name.endsWith(".css")) out.push(p);
	}
	return out;
}

describe("shared focus layer (#2169)", () => {
	it("defines one :where(...):focus-visible rule painting the token in global.css", () => {
		const css = readFileSync(GLOBAL_CSS, "utf8");
		// zero-specificity :where() selector so component variants override without a fight
		expect(css).toMatch(/:where\([^)]*\):focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/s);
		expect(css).toMatch(
			/:where\([^)]*\):focus-visible\s*\{[^}]*outline-offset:\s*var\(--focus-ring-offset\)/s,
		);
	});

	it("no component/page CSS re-declares outline: var(--focus-ring) (single source)", () => {
		// Only the skip-link's deliberate `:focus` (not `:focus-visible`) ring is exempt.
		const allow = new Set([join(SRC, "components", "layout", "AppShell.css")]);
		const offenders = cssFiles(SRC)
			.filter((f) => f !== GLOBAL_CSS && !allow.has(f))
			.filter((f) => /outline:\s*var\(--focus-ring\)/.test(readFileSync(f, "utf8")));
		expect(offenders).toEqual([]);
	});

	it("no component/page CSS hand-rolls a divergent 2px-solid-accent focus ring", () => {
		const offenders = cssFiles(SRC).filter((f) =>
			/outline:\s*2px solid var\(--accent\)/.test(readFileSync(f, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
