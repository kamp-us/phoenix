import {describe, expect, it} from "vitest";
import {
	appForSurface,
	DEFAULT_VIEWPORT,
	fillPorts,
	type HarnessApp,
	type HarnessConfig,
	LIST_VIOLATION,
	parseHarness,
	portTokens,
	surfacePath,
	surfaceSlug,
	surfaceUrl,
} from "./harness.ts";

const WEB = {name: "web", mount: "/", command: "pnpm dev --port {{port}}"};
const TUVAL = {
	name: "tuval-chat",
	mount: "/tuval/chat",
	basePath: "/",
	command: "pnpm proof:chat --port {{port}}",
};

const config = (overrides: Record<string, unknown> = {}, apps: ReadonlyArray<unknown> = [WEB]) =>
	JSON.stringify({apps, ...overrides});

/** The parsed config, or a thrown assertion — every reader below wants the Config arm. */
const parsed = (text: string): HarnessConfig => {
	const answer = parseHarness(text);
	if (answer._tag !== "Config") throw new Error(`expected a Config, got: ${answer.violation}`);
	return answer.config;
};

describe("parseHarness", () => {
	it("defaults readyPath, basePath, viewport and the two optional top-level keys", () => {
		expect(parseHarness(config())).toEqual({
			_tag: "Config",
			config: {
				apps: [{...WEB, basePath: null, readyPath: "/"}],
				viewport: DEFAULT_VIEWPORT,
				evidenceStore: null,
				storageState: null,
			},
		});
	});

	it("accepts more than one app, each with its own command, mount and readiness probe", () => {
		const answer = parsed(
			config({}, [
				{...WEB, readyPath: "/api/health"},
				{...TUVAL, readyPath: "/index.html"},
			]),
		);
		expect(answer.apps.map((app) => [app.name, app.mount, app.readyPath])).toEqual([
			["web", "/", "/api/health"],
			["tuval-chat", "/tuval/chat", "/index.html"],
		]);
	});

	it("carries a declared storageState through", () => {
		expect(parsed(config({storageState: ".fabrika/design-session.json"})).storageState).toBe(
			".fabrika/design-session.json",
		);
	});

	it("carries a declared viewport and evidenceStore through", () => {
		const answer = parsed(
			config({viewport: {width: 390, height: 844}, evidenceStore: "https://depo/x"}),
		);
		expect(answer.viewport).toEqual({width: 390, height: 844});
		expect(answer.evidenceStore).toBe("https://depo/x");
	});

	it.each([
		["no apps key", JSON.stringify({}), '"apps" is not a non-empty array of app declarations'],
		["an empty apps list", config({}, []), '"apps" is not a non-empty array of app declarations'],
		[
			"a non-array apps",
			JSON.stringify({apps: {}}),
			'"apps" is not a non-empty array of app declarations',
		],
		[
			"an app with no name",
			config({}, [{mount: "/", command: "x {{port}}"}]),
			'"apps[].name" is missing or is not a kebab-case app name',
		],
		[
			"a non-kebab app name",
			config({}, [{...WEB, name: "Web App"}]),
			'"apps[].name" is missing or is not a kebab-case app name',
		],
		[
			"an app with no command",
			config({}, [{name: "web", mount: "/"}]),
			'"apps[].command" is missing or not a non-empty string',
		],
		[
			"a non-string command",
			config({}, [{...WEB, command: 3}]),
			'"apps[].command" is missing or not a non-empty string',
		],
		[
			"an app with no mount",
			config({}, [{name: "web", command: "x {{port}}"}]),
			'"apps[].mount" is missing or is not a path beginning with "/"',
		],
		[
			"a relative mount",
			config({}, [{...WEB, mount: "lab"}]),
			'"apps[].mount" is missing or is not a path beginning with "/"',
		],
		[
			"a relative basePath",
			config({}, [{...WEB, basePath: "lab"}]),
			'"apps[].basePath" is not a path beginning with "/"',
		],
		[
			"a relative readyPath",
			config({}, [{...WEB, readyPath: "health"}]),
			'"apps[].readyPath" is not a path beginning with "/"',
		],
		[
			"a null readyPath",
			config({}, [{...WEB, readyPath: null}]),
			'"apps[].readyPath" is not a path beginning with "/"',
		],
		[
			"a fractional viewport",
			config({viewport: {width: 12.5, height: 900}}),
			'"viewport.width" is not a positive integer',
		],
		["a non-object viewport", config({viewport: 3}), '"viewport" is not an object'],
		[
			"an unknown key inside viewport",
			config({viewport: {width: 390, height: 844, depth: 2}}),
			'unknown key "depth"',
		],
		["an unknown top-level key", config({browser: "chromium"}), 'unknown key "browser"'],
		["an unknown key inside an app", config({}, [{...WEB, url: "http://x"}]), 'unknown key "url"'],
		[
			"an absolute storageState",
			config({storageState: "/Users/someone/session.json"}),
			'"storageState" is not a repo-root-relative path',
		],
		[
			"an empty storageState",
			config({storageState: "   "}),
			'"storageState" is not a repo-root-relative path',
		],
		["a non-object top level", JSON.stringify([]), "the top level is not an object"],
	])("refuses %s whole-file", (_label, text, violation) => {
		expect(parseHarness(text)).toEqual({_tag: "Violation", violation});
	});

	it.each([
		[
			"a command with no {{port}} placeholder",
			config({}, [{...WEB, command: "pnpm dev"}]),
			LIST_VIOLATION.noPort("web"),
		],
		[
			"a command carrying only a NAMED port token",
			config({}, [{...WEB, command: "pnpm dev --worker {{port:worker}}"}]),
			LIST_VIOLATION.noPort("web"),
		],
		[
			"two apps under one name",
			config({}, [WEB, {...TUVAL, name: "web"}]),
			LIST_VIOLATION.duplicateName("web"),
		],
		[
			"two apps under one mount",
			config({}, [WEB, {...TUVAL, mount: "/"}]),
			LIST_VIOLATION.duplicateMount("/"),
		],
	])("refuses %s — the whole-list rule no field check can state", (_label, text, violation) => {
		expect(parseHarness(text)).toEqual({_tag: "Violation", violation});
	});

	it("refuses a file that is not JSON, naming the parse error", () => {
		const answer = parseHarness("{oops");
		expect(answer._tag).toBe("Violation");
		if (answer._tag !== "Violation") return;
		expect(answer.violation).toMatch(/^the file is not JSON \(/);
	});

	it("reads an explicit null evidenceStore as no store", () => {
		expect(parsed(config({evidenceStore: null})).evidenceStore).toBeNull();
	});
});

describe("port tokens", () => {
	it("names every distinct token once, the unnamed one as the empty string", () => {
		expect(portTokens("a {{port}} b {{port:worker}} c {{port}} d {{port:pi-page}}")).toEqual([
			"",
			"worker",
			"pi-page",
		]);
	});

	it("fills every occurrence of a token from one allocation", () => {
		const filled = fillPorts(
			"WORKER={{port:worker}} vite --port {{port}} --proxy {{port:worker}}",
			new Map([
				["", 51234],
				["worker", 51235],
			]),
		);
		expect(filled).toBe("WORKER=51235 vite --port 51234 --proxy 51235");
	});

	it("leaves a token no allocation names alone rather than writing undefined into a command", () => {
		expect(fillPorts("vite --port {{port}} --x {{port:worker}}", new Map([["", 5173]]))).toBe(
			"vite --port 5173 --x {{port:worker}}",
		);
	});
});

describe("appForSurface", () => {
	const multi = parsed(
		config({}, [WEB, TUVAL, {name: "web-lab", mount: "/lab", command: "vite --port {{port}}"}]),
	);
	const named = (surface: string) => appForSurface(multi, surface)?.name ?? null;

	it.each([
		["/", "web"],
		["/pano", "web"],
		["/labs/x", "web"],
		["/lab", "web-lab"],
		["/lab/atolye/agent-chat-input", "web-lab"],
		["/tuval/chat", "tuval-chat"],
		["/tuval/chat/deep", "tuval-chat"],
		["/tuval", "web"],
	])("resolves %s to the app with the longest claiming mount (%s)", (surface, name) => {
		expect(named(surface)).toBe(name);
	});

	it("answers null when no mount claims the surface", () => {
		const mounted = parsed(config({}, [TUVAL]));
		expect(appForSurface(mounted, "/pano")).toBeNull();
	});
});

describe("surfacePath and surfaceUrl", () => {
	const app = (overrides: Partial<HarnessApp>): HarnessApp => ({
		name: "x",
		command: "x {{port}}",
		mount: "/",
		basePath: null,
		readyPath: "/",
		...overrides,
	});

	it.each([
		["a catch-all mount is the identity", {mount: "/"}, "/lab/atolye/x", "/lab/atolye/x"],
		["a mount with no basePath is the identity", {mount: "/lab"}, "/lab/atolye/x", "/lab/atolye/x"],
		["a basePath rewrites the mount", {mount: "/tuval/chat", basePath: "/"}, "/tuval/chat", "/"],
		[
			"a basePath rewrites the mount and keeps the remainder",
			{mount: "/tuval/chat", basePath: "/"},
			"/tuval/chat/deep",
			"/deep",
		],
		[
			"a basePath may be deeper than the mount",
			{mount: "/pi", basePath: "/window/proof"},
			"/pi/a",
			"/window/proof/a",
		],
	])("%s", (_label, overrides, surface, path) => {
		expect(surfacePath(app(overrides), surface)).toBe(path);
	});

	it("builds the URL on the origin its app actually bound, trailing slash trimmed", () => {
		expect(surfaceUrl("http://127.0.0.1:51234/", app({mount: "/"}), "/pano")).toBe(
			"http://127.0.0.1:51234/pano",
		);
	});
});

describe("surfaceSlug", () => {
	it.each([
		["/", "root"],
		["/pano", "pano"],
		["/pano/yeni", "pano-yeni"],
		["/tuval/chat", "tuval-chat"],
	])("slugs %s as %s", (route, slug) => {
		expect(surfaceSlug(route)).toBe(slug);
	});
});
