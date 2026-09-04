/**
 * The pure rule behind `guard i18n-guard check` (#7536) — what the scanner counts as copy, what it
 * refuses to count, and how the two allowance buckets ratchet. Scope resolution and the fail-closed
 * floor are covered in `i18n-literal-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	type FileScan,
	type I18nGuardConfig,
	isInScope,
	judge,
	renderReport,
	scanSource,
} from "./i18n-literal.ts";

const kinds = (src: string) => scanSource(src).map((h) => `${h.line}:${h.kind}:${h.excerpt}`);

describe("scanSource", () => {
	it("reds a Turkish double-quoted literal", () => {
		expect(kinds('const label = "giriş yap";\n')).toEqual(["1:string:giriş yap"]);
	});

	it("reds Turkish JSX text between tags", () => {
		expect(kinds("<p>yükleniyor…</p>\n")).toEqual(["1:jsx-text:yükleniyor"]);
	});

	it("reds Turkish inside a template literal, on both sides of a hole", () => {
		expect(kinds(`const s = \`açık \${n} kalıcı\`;\n`)).toEqual([
			"1:string:açık",
			"1:string:kalıcı",
		]);
	});

	it("passes an English literal beside a Turkish comment", () => {
		expect(kinds('// çaylak\'s marker\nconst a = "load more";\n')).toEqual([]);
	});

	it("passes Turkish in a block comment, including a JSX one", () => {
		expect(kinds("{/* the reader-facing çaylak marker */}\n<p>load more</p>\n")).toEqual([]);
	});

	it("passes a regex literal over the Turkish alphabet", () => {
		expect(kinds("term.replace(/[çğıöşü]/g, (c) => c);\n")).toEqual([]);
	});

	it("passes an unquoted object key, and still reds a Turkish value beside it", () => {
		expect(kinds('const fold = {ç: "c", ğ: "gösterge"};\n')).toEqual(["1:string:gösterge"]);
	});

	it("keeps reading after an apostrophe in JSX text that no quote closes", () => {
		expect(kinds("<p>somebody else's entry</p>\n<p>giriş</p>\n")).toEqual(["2:jsx-text:giriş"]);
	});

	it("does not resume the template on a brace that closes an object in the hole", () => {
		expect(kinds(`const s = \`a \${f({k: 1})} kalıcı\`;\n`)).toEqual(["1:string:kalıcı"]);
	});

	it("passes a file with no Turkish at all", () => {
		expect(kinds('export const a = "load more"; // nothing here\n')).toEqual([]);
	});
});

describe("isInScope", () => {
	it("takes a non-test source under apps/web/src", () => {
		expect(isInScope("apps/web/src/App.tsx")).toBe(true);
		expect(isInScope("apps/web/src/lib/panoNav.ts")).toBe(true);
	});

	it("drops the catalog, the lab, the tests and everything outside apps/web/src", () => {
		expect(isInScope("apps/web/src/i18n/tr/layout.ts")).toBe(false);
		expect(isInScope("apps/web/src/lab/atolye/exhibits/Button.exhibit.tsx")).toBe(false);
		expect(isInScope("apps/web/src/App.test.tsx")).toBe(false);
		expect(isInScope("apps/web/src/lib/panoNav.unit.test.ts")).toBe(false);
		expect(isInScope("apps/web/worker/index.ts")).toBe(false);
		expect(isInScope("apps/web/src/styles/tokens.css")).toBe(false);
	});
});

const scan = (path: string, count: number): FileScan => ({
	path,
	hits: Array.from({length: count}, (_, i) => ({
		line: i + 1,
		kind: "string" as const,
		excerpt: "giriş",
	})),
});

const config = (over: Partial<I18nGuardConfig> = {}): I18nGuardConfig => ({
	exempt: {},
	unmigrated: {},
	...over,
});

describe("judge", () => {
	it("passes a corpus with no Turkish anywhere", () => {
		expect(judge({files: [scan("apps/web/src/App.tsx", 0)], config: config()})).toMatchObject({
			_tag: "Clean",
			filesScanned: 1,
			allowed: 0,
		});
	});

	it("reds a Turkish literal in a file carrying no allowance", () => {
		const verdict = judge({files: [scan("apps/web/src/App.tsx", 1)], config: config()});
		expect(verdict._tag).toBe("Violation");
		expect(renderReport(verdict)).toContain("apps/web/src/App.tsx — 1 hit(s), ceiling 0");
	});

	it("passes a file at its ceiling and reds it one literal later", () => {
		const allowance = {ceiling: 2, why: "the wire tier value"};
		const files = [scan("apps/web/src/App.tsx", 2)];
		expect(
			judge({files, config: config({exempt: {"apps/web/src/App.tsx": allowance}})}),
		).toMatchObject({_tag: "Clean", allowed: 1});
		expect(
			judge({
				files: [scan("apps/web/src/App.tsx", 3)],
				config: config({exempt: {"apps/web/src/App.tsx": allowance}}),
			})._tag,
		).toBe("Violation");
	});

	it("honours an unmigrated allowance the same way an exempt one works", () => {
		expect(
			judge({
				files: [scan("apps/web/src/App.tsx", 1)],
				config: config({unmigrated: {"apps/web/src/App.tsx": {ceiling: 1, why: "debt, #7723"}}}),
			})._tag,
		).toBe("Clean");
	});

	it("reds an allowance naming a file the scan never saw", () => {
		const verdict = judge({
			files: [scan("apps/web/src/App.tsx", 0)],
			config: config({unmigrated: {"apps/web/src/Gone.tsx": {ceiling: 1, why: "stale"}}}),
		});
		expect(verdict._tag).toBe("Violation");
		expect(renderReport(verdict)).toContain("a `unmigrated` allowance names a file");
	});

	it("reds an empty corpus rather than passing vacuously", () => {
		const verdict = judge({files: [], config: config()});
		expect(verdict._tag).toBe("ZeroScope");
		expect(renderReport(verdict)).toContain("scope resolved empty");
	});
});
