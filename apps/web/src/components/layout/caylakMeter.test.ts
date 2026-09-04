// The chip's derivation is pure, so the honesty rule and the delta copy are asserted as
// values — `apps/web/src` has no jsdom. The rendered half lives in `Topbar.test.tsx`.
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {promotionBarFor, VOUCH_PROMOTION_KARMA_BAR} from "../../../worker/features/kunye/standing";
import {trCatalog} from "../../i18n";
import {STANDING_FIELDS, VOUCH_NEEDED_KEYS} from "../profile/CaylakStatusBlock";
import {caylakMeter, vouchFactKey} from "./caylakMeter";

// Fixtures built from `promotionBarFor`, not from literals: `bar` is whatever the wire's own
// producer sends for that vouch state, so an unvouched case can never drift back to a standing
// the backend cannot emit (`{bar: 15, vouchExists: false}`).
const unvouched = (karma: number) => ({karma, bar: promotionBarFor(false), vouchExists: false});
const vouched = (karma: number) => ({karma, bar: promotionBarFor(true), vouchExists: true});

describe("caylakMeter — the next unmet condition, with its delta", () => {
	it("names the karma delta and the kefil fact for an unvouched çaylak", () => {
		const meter = caylakMeter(unvouched(9));
		expect(meter.kind).toBe("vouch-needed");
		expect(meter.karma).toBe(9);
		expect(trCatalog[meter.vouchFactKey]).toBe("kefil: yok");
	});

	it("carries CaylakStatusBlock's settled vouch-needed copy, never a second wording", () => {
		const meter = caylakMeter(unvouched(9));
		expect(meter.kind === "vouch-needed" && meter.vouchNeededKey).toBe(VOUCH_NEEDED_KEYS.message);
	});

	it("becomes the honest karma bar once a kefil exists", () => {
		const meter = caylakMeter(vouched(9));
		expect(meter.kind).toBe("karma-bar");
		expect(trCatalog[meter.vouchFactKey]).toBe("kefil: var");
	});

	it("inherits the #1323 honesty rule: no karma-bar variant is reachable while unvouched", () => {
		for (const karma of [-3, 0, 9, 15, 99]) {
			expect(caylakMeter(unvouched(karma)).kind).toBe("vouch-needed");
		}
	});

	// The wire sends the unassisted 100 while unvouched, and that is the goal #1323 calls
	// unlivable. Naming it in the chip would move the dishonesty out of the bar and into a
	// string, so the delta reads against the reduced bar the kefil buys down to.
	it("names the reduced bar for an unvouched çaylak, never the 100 the wire sends", () => {
		const standing = unvouched(9);
		expect(standing.bar).toBe(100);
		const meter = caylakMeter(standing);
		expect(meter.target).toBe(VOUCH_PROMOTION_KARMA_BAR);
		expect(`karma ${meter.karma}/${meter.target} · ${trCatalog[meter.vouchFactKey]}`).toBe(
			"karma 9/15 · kefil: yok",
		);
	});

	it("reports a vouched delta against the bar it was handed, never a re-derived target", () => {
		const meter = caylakMeter({karma: 40, bar: 100, vouchExists: true});
		expect(`karma ${meter.karma}/${meter.target} · ${trCatalog[meter.vouchFactKey]}`).toBe(
			"karma 40/100 · kefil: var",
		);
	});
});

describe("vouchFactKey", () => {
	it("picks the catalog key whose tr copy prefixes the var/yok readout with the kefil term", () => {
		expect(trCatalog[vouchFactKey(true)]).toBe("kefil: var");
		expect(trCatalog[vouchFactKey(false)]).toBe("kefil: yok");
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
		const meter = caylakMeter(unvouched(9));
		// Structurally: extra keys on the standing argument cannot reach the output, because
		// every field of the result is derived from those three.
		expect(Object.keys(meter).sort()).toEqual([
			"karma",
			"kind",
			"target",
			"vouchFactKey",
			"vouchNeededKey",
		]);
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
