import {describe, expect, it} from "vitest";
import {DEFAULT_VIEWPORT, parseHarness, surfaceSlug} from "./harness.ts";

const config = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({command: "pnpm dev", url: "http://127.0.0.1:5173", ...overrides});

describe("parseHarness", () => {
	it("defaults readyPath and viewport, and trims the base URL", () => {
		const parsed = parseHarness(config({url: "http://127.0.0.1:5173/"}));
		expect(parsed).toEqual({
			_tag: "Config",
			config: {
				command: "pnpm dev",
				url: "http://127.0.0.1:5173",
				readyPath: "/",
				viewport: DEFAULT_VIEWPORT,
				evidenceStore: null,
			},
		});
	});

	it("carries a declared viewport, readyPath and evidenceStore through", () => {
		const parsed = parseHarness(
			config({
				readyPath: "/health",
				viewport: {width: 390, height: 844},
				evidenceStore: "https://depo/x",
			}),
		);
		expect(parsed._tag).toBe("Config");
		if (parsed._tag !== "Config") return;
		expect(parsed.config.viewport).toEqual({width: 390, height: 844});
		expect(parsed.config.readyPath).toBe("/health");
		expect(parsed.config.evidenceStore).toBe("https://depo/x");
	});

	it.each([
		[
			"no command",
			JSON.stringify({url: "http://x"}),
			'"command" is missing or not a non-empty string',
		],
		["a non-URL url", config({url: "127.0.0.1"}), '"url" is missing or is not an http(s) base URL'],
		[
			"a relative readyPath",
			config({readyPath: "health"}),
			'"readyPath" is not a path beginning with "/"',
		],
		[
			"a fractional viewport",
			config({viewport: {width: 12.5, height: 900}}),
			'"viewport.width" is not a positive integer',
		],
		["an unknown key", config({browser: "chromium"}), 'unknown key "browser"'],
		[
			"a non-string command",
			config({command: 3}),
			'"command" is missing or not a non-empty string',
		],
		["a non-string url", config({url: 3}), '"url" is missing or is not an http(s) base URL'],
		["a null readyPath", config({readyPath: null}), '"readyPath" is not a path beginning with "/"'],
		["a non-object viewport", config({viewport: 3}), '"viewport" is not an object'],
		[
			"an unknown key inside viewport",
			config({viewport: {width: 390, height: 844, depth: 2}}),
			'unknown key "depth"',
		],
		["a non-object top level", JSON.stringify([]), "the top level is not an object"],
	])("refuses %s whole-file", (_label, text, violation) => {
		expect(parseHarness(text)).toEqual({_tag: "Violation", violation});
	});

	it("refuses a file that is not JSON, naming the parse error", () => {
		const parsed = parseHarness("{oops");
		expect(parsed._tag).toBe("Violation");
		if (parsed._tag !== "Violation") return;
		expect(parsed.violation).toMatch(/^the file is not JSON \(/);
	});

	it("reads an explicit null evidenceStore as no store", () => {
		const parsed = parseHarness(config({evidenceStore: null}));
		expect(parsed._tag).toBe("Config");
		if (parsed._tag !== "Config") return;
		expect(parsed.config.evidenceStore).toBeNull();
	});
});

describe("surfaceSlug", () => {
	it.each([
		["/", "root"],
		["/pano", "pano"],
		["/pano/yeni", "pano-yeni"],
	])("slugs %s as %s", (route, slug) => {
		expect(surfaceSlug(route)).toBe(slug);
	});
});
