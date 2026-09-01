// The chip's derivation is pure, so the honesty rule and the delta copy are asserted as
// values — `apps/web/src` has no jsdom. The rendered half lives in `Topbar.test.tsx`.
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {STANDING_FIELDS, VOUCH_NEEDED_COPY} from "../profile/CaylakStatusBlock";
import {caylakMeter, vouchFactLabel} from "./caylakMeter";

describe("caylakMeter — the next unmet condition, with its delta", () => {
	it("names the karma delta and the kefil fact for an unvouched çaylak", () => {
		const meter = caylakMeter({karma: 9, bar: 15, vouchExists: false});
		expect(meter.kind).toBe("vouch-needed");
		expect(meter.karma).toBe(9);
		expect(meter.bar).toBe(15);
		expect(meter.vouchFact).toBe("kefil: yok");
	});

	it("carries CaylakStatusBlock's settled vouch-needed copy, never a second wording", () => {
		const meter = caylakMeter({karma: 9, bar: 15, vouchExists: false});
		expect(meter.kind === "vouch-needed" && meter.vouchNeeded).toBe(VOUCH_NEEDED_COPY.message);
	});

	it("becomes the honest karma bar once a kefil exists", () => {
		const meter = caylakMeter({karma: 9, bar: 15, vouchExists: true});
		expect(meter.kind).toBe("karma-bar");
		expect(meter.vouchFact).toBe("kefil: var");
	});

	it("inherits the #1323 honesty rule: no karma-bar variant is reachable while unvouched", () => {
		for (const karma of [-3, 0, 9, 15, 99]) {
			expect(caylakMeter({karma, bar: 15, vouchExists: false}).kind).toBe("vouch-needed");
		}
	});

	it("reports the delta against the bar it was handed, never a re-derived target", () => {
		const meter = caylakMeter({karma: 40, bar: 100, vouchExists: true});
		expect(`karma ${meter.karma}/${meter.bar} · ${meter.vouchFact}`).toBe(
			"karma 40/100 · kefil: var",
		);
	});
});

describe("vouchFactLabel", () => {
	it("prefixes the shared var/yok readout with the kefil term", () => {
		expect(vouchFactLabel(true)).toBe("kefil: var");
		expect(vouchFactLabel(false)).toBe("kefil: yok");
	});
});

describe("the meter reads the aggregate-only standing selection and nothing more", () => {
	// Criterion 4: the chip's input is a SUBSET of `STANDING_FIELDS`, and that selection stays
	// the five aggregate keys — widening either side (a voucher/reviewer identity, a second
	// source) reds here before it can reach the chrome.
	it("STANDING_FIELDS is exactly the five aggregate keys", () => {
		expect(Object.keys(STANDING_FIELDS).sort()).toEqual([
			"bar",
			"id",
			"inReviewCount",
			"karma",
			"vouchExists",
		]);
	});

	it("the meter's own input names only karma, bar and vouchExists", () => {
		const meter = caylakMeter({karma: 9, bar: 15, vouchExists: false});
		// Structurally: extra keys on the standing argument cannot reach the output, because
		// every field of the result is derived from those three.
		expect(Object.keys(meter).sort()).toEqual(["bar", "karma", "kind", "vouchFact", "vouchNeeded"]);
	});

	// "a second standing source appears" is a SOURCE fact, not a value one: a new reader anywhere
	// in the SPA would read the same view through a second selection nothing here constrains. One
	// call site, in the one module that owns `STANDING_FIELDS` — the tripwire idiom Topbar.test.tsx
	// uses for CSS.
	//
	// The guard names the VIEW, not one call shape: matching `useImperativeView(\s*"…"` let a
	// single-quoted, backticked or const-named root walk straight past it. A second reader has to
	// name the view in a string literal somewhere, so that is what is scanned — over code with
	// comments removed, since every docblock here quotes the name in prose.
	const codeOnly = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
	const NAMES_THE_VIEW = /(["'`])myAuthorshipStanding\1/;

	it("the guard matches every spelling of the root, and no prose mention of it", () => {
		for (const spelling of [
			'useImperativeView("myAuthorshipStanding", V, o)',
			"useImperativeView('myAuthorshipStanding', V, o)",
			"useImperativeView(`myAuthorshipStanding`, V, o)",
			'const ROOT = "myAuthorshipStanding";\nuseImperativeView(ROOT, V, o)',
		]) {
			expect(NAMES_THE_VIEW.test(codeOnly(spelling))).toBe(true);
		}
		expect(NAMES_THE_VIEW.test(codeOnly("// reads `myAuthorshipStanding`"))).toBe(false);
		expect(NAMES_THE_VIEW.test(codeOnly("/* the `myAuthorshipStanding` read */"))).toBe(false);
	});

	it("exactly one module in apps/web/src reads the myAuthorshipStanding view", () => {
		const src = fileURLToPath(new URL("../../", import.meta.url));
		// Yields paths RELATIVE to `src`, so the assertion below reads as a repo path.
		const sources = (rel: string): string[] =>
			readdirSync(`${src}${rel}`, {withFileTypes: true}).flatMap((e) =>
				e.isDirectory()
					? sources(`${rel}${e.name}/`)
					: /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
						? [`${rel}${e.name}`]
						: [],
			);
		const readers = sources("").filter((f) =>
			NAMES_THE_VIEW.test(codeOnly(readFileSync(`${src}${f}`, "utf8"))),
		);
		expect(readers).toEqual(["components/profile/CaylakStatusBlock.tsx"]);
	});
});
