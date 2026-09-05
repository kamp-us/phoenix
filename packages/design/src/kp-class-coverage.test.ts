/**
 * Every `kp-*` class a component under `src/` names must be declared by a stylesheet under `src/`.
 *
 * The package shipped `kp-visually-hidden` for months with its only declaration in `apps/web`'s
 * app-owned `global.css`, so every consumer that was not that app rendered the hidden text at full
 * width — Tuval's composer pushed the page into horizontal scroll (#7984). Nothing caught it
 * because a class reference and a class declaration live in different files and no check compared
 * them. This is that comparison.
 *
 * Two limits, both deliberate. A class assembled from a template literal (`kp-surface--tone-${t}`)
 * is not checked, because its full name does not exist in the source; the static prefix is skipped
 * rather than reported as missing. And a class with no rule is not always a defect — some are
 * consumer-facing hooks — so those are named in `UNSTYLED_HOOKS` with a reason each, never
 * tolerated silently.
 */

import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * Classes a component names purely as a hook — no rule in this package, and none owed. Each entry
 * carries why; an entry that gains a rule loses its place here.
 */
const UNSTYLED_HOOKS: Readonly<Record<string, string>> = {
	"kp-card": "Card's naming hook over Surface, which carries every rule the card renders with.",
	"kp-edited-indicator": "Marker for consumers to target; the indicator's own styling is Tag's.",
	"kp-agent-chat__delivery": "Hook on the delivery Select; the control's styling is Manti's.",
	"kp-agent-chat__error": "Hook on the error Alert; the styling is Alert's own.",
	"kp-agent-chat__setting-select--model":
		"Modifier hook beside the styled `kp-agent-chat__setting-select` base.",
};

const walk = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, {withFileTypes: true}).flatMap((entry) =>
		entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
	);

/** Block and line comments are prose, not class references — a name inside one is not a use. */
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const files = walk(SRC);

const referenced = (): ReadonlyMap<string, ReadonlyArray<string>> => {
	const found = new Map<string, Array<string>>();
	for (const file of files) {
		if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
		// The lookahead drops the static head of an interpolated name, which is not a class. It has
		// to bar a name character too: without that, `kp-tone-${t}` backtracks one character and
		// reports `kp-tone` as a missing class.
		for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(
			/\bkp-[A-Za-z0-9_-]+(?![A-Za-z0-9_-]|\$\{)/g,
		)) {
			const sites = found.get(match[0]) ?? [];
			sites.push(file.slice(SRC.length + 1));
			found.set(match[0], sites);
		}
	}
	return found;
};

const declared = (): ReadonlySet<string> => {
	const found = new Set<string>();
	for (const file of files) {
		if (!file.endsWith(".css")) continue;
		for (const [, name] of readFileSync(file, "utf8").matchAll(/\.(kp-[A-Za-z0-9_-]+)/g)) {
			if (name !== undefined) found.add(name);
		}
	}
	return found;
};

describe("every kp-* class a component names", () => {
	it("is declared by a stylesheet this package ships", () => {
		const rules = declared();
		const undeclared = [...referenced()]
			.filter(([name]) => !rules.has(name) && !(name in UNSTYLED_HOOKS))
			.map(([name, sites]) => `${name} (${sites.join(", ")})`)
			.sort();
		expect(undeclared).toEqual([]);
	});

	it("covers the visually-hidden class, whose absence was the defect", () => {
		expect(declared().has("kp-visually-hidden")).toBe(true);
		expect([...referenced().keys()]).toContain("kp-visually-hidden");
	});

	it("leaves no stale entry in the unstyled-hook list", () => {
		const rules = declared();
		const used = referenced();
		const stale = Object.keys(UNSTYLED_HOOKS).filter((name) => rules.has(name) || !used.has(name));
		expect(stale).toEqual([]);
	});
});
