import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {
	DEFAULT_VIEWPORT,
	fillPorts,
	LIST_VIOLATION,
	portTokens,
	prefixesOf,
	UI_CAPTURE,
	UI_SURFACES,
	type UiSurface,
	uiCaptureKey,
	uiSurfacesKey,
} from "./ui-surfaces.ts";

const WEB = {
	name: "web",
	prefix: "apps/web/src/",
	mount: "/",
	command: "pnpm dev --port {{port}}",
};
const TUVAL = {
	name: "tuval-chat",
	prefix: "apps/tuval/src/",
	mount: "/tuval/chat",
	basePath: "/",
	command: "pnpm proof:chat --port {{port}}",
};

const load = (config: Record<string, unknown>) =>
	loadConfig({_tag: "Text", text: JSON.stringify(config)});

const declared = (rows: ReadonlyArray<unknown> = [WEB]) =>
	resolve(load({[UI_SURFACES]: rows}), uiSurfacesKey);

/** The decoded rows, or a thrown assertion — every reader below wants the Declared arm. */
const rowsOf = (rows: ReadonlyArray<unknown>): ReadonlyArray<UiSurface> => {
	const answer = declared(rows);
	if (answer._tag !== "Declared") {
		throw new Error(`expected Declared, got ${answer._tag}: ${JSON.stringify(answer)}`);
	}
	return answer.value;
};

describe("the shipped default", () => {
	it("is the empty list on both no-file and no-key, so no repo inherits phoenix's surfaces", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), uiSurfacesKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
		expect(resolve(load({}), uiSurfacesKey)).toMatchObject({_tag: "Default", value: []});
	});

	it("admits a declared empty list — no rendered gate is a declaration, not a malformity", () => {
		expect(declared([])).toMatchObject({_tag: "Declared", value: []});
	});

	it("defaults the capture settings a repo declares none of", () => {
		expect(resolve(load({}), uiCaptureKey)).toMatchObject({
			_tag: "Default",
			value: {viewport: DEFAULT_VIEWPORT, evidenceStore: null, storageState: null},
		});
	});
});

describe("a declared uiSurfaces row", () => {
	it("defaults readyPath and basePath", () => {
		expect(rowsOf([WEB])).toEqual([{...WEB, basePath: null, readyPath: "/"}]);
	});

	it("accepts more than one row, each with its own command, mount and readiness probe", () => {
		const answer = rowsOf([
			{...WEB, readyPath: "/api/health"},
			{...TUVAL, readyPath: "/index.html"},
		]);
		expect(answer.map((row) => [row.name, row.mount, row.readyPath])).toEqual([
			["web", "/", "/api/health"],
			["tuval-chat", "/tuval/chat", "/index.html"],
		]);
	});

	it("allows two rows under one prefix — web and web-lab are two mounts over one source root", () => {
		const answer = rowsOf([WEB, {...WEB, name: "web-lab", mount: "/lab"}]);
		expect(prefixesOf(answer)).toEqual(["apps/web/src/"]);
	});

	const NAME = `"${UI_SURFACES}[].name" is missing or is not a kebab-case app name`;
	const COMMAND = `"${UI_SURFACES}[].command" is missing or not a non-empty string`;
	const PREFIX = `"${UI_SURFACES}[].prefix" is missing or is not a repo-relative directory prefix ending in "/"`;
	const MOUNT = `"${UI_SURFACES}[].mount" is missing or is not a path beginning with "/"`;
	const BASE_PATH = `"${UI_SURFACES}[].basePath" is not a path beginning with "/"`;
	const READY_PATH = `"${UI_SURFACES}[].readyPath" is not a path beginning with "/"`;

	it.each([
		["no name", [{prefix: "a/", mount: "/", command: "x {{port}}"}], NAME],
		["a non-kebab name", [{...WEB, name: "Web App"}], NAME],
		["no command", [{name: "web", prefix: "a/", mount: "/"}], COMMAND],
		["a non-string command", [{...WEB, command: 3}], COMMAND],
		["no prefix", [{name: "web", mount: "/", command: "x {{port}}"}], PREFIX],
		["a prefix with no trailing slash", [{...WEB, prefix: "apps/web/src"}], PREFIX],
		["an absolute prefix", [{...WEB, prefix: "/apps/web/src/"}], PREFIX],
		["a parent-relative prefix", [{...WEB, prefix: "../web/src/"}], PREFIX],
		["no mount", [{name: "web", prefix: "a/", command: "x {{port}}"}], MOUNT],
		["a relative mount", [{...WEB, mount: "lab"}], MOUNT],
		["a relative basePath", [{...WEB, basePath: "lab"}], BASE_PATH],
		["a relative readyPath", [{...WEB, readyPath: "health"}], READY_PATH],
		["a null readyPath", [{...WEB, readyPath: null}], READY_PATH],
		["an unknown key inside a row", [{...WEB, url: "http://x"}], 'unknown key "url"'],
	])("refuses %s whole-value, naming the field it rejected", (_label, rows, reason) => {
		expect(declared(rows)).toMatchObject({_tag: "Malformed", reason});
	});

	it("refuses a value that is not an array at all", () => {
		expect(resolve(load({[UI_SURFACES]: {}}), uiSurfacesKey)).toMatchObject({
			_tag: "Malformed",
			reason: `\`${UI_SURFACES}\` is not an array of surface declarations`,
		});
	});

	it.each([
		[
			"a command with no {{port}} placeholder",
			[{...WEB, command: "pnpm dev"}],
			LIST_VIOLATION.noPort("web"),
		],
		[
			"a command carrying only a NAMED port token",
			[{...WEB, command: "pnpm dev --worker {{port:worker}}"}],
			LIST_VIOLATION.noPort("web"),
		],
		[
			"two rows under one name",
			[WEB, {...TUVAL, name: "web"}],
			LIST_VIOLATION.duplicateName("web"),
		],
		["two rows under one mount", [WEB, {...TUVAL, mount: "/"}], LIST_VIOLATION.duplicateMount("/")],
	])("refuses %s — the whole-list rule no field check can state", (_label, rows, reason) => {
		expect(declared(rows)).toMatchObject({_tag: "Malformed", reason});
	});
});

describe("a declared uiCapture", () => {
	const capture = (value: Record<string, unknown>) =>
		resolve(load({[UI_CAPTURE]: value}), uiCaptureKey);

	it("carries a declared storageState through", () => {
		expect(capture({storageState: ".fabrika/design-session.json"})).toMatchObject({
			_tag: "Declared",
			value: {storageState: ".fabrika/design-session.json"},
		});
	});

	it("carries a declared viewport and evidenceStore through", () => {
		expect(
			capture({viewport: {width: 390, height: 844}, evidenceStore: "https://depo/x"}),
		).toMatchObject({
			_tag: "Declared",
			value: {viewport: {width: 390, height: 844}, evidenceStore: "https://depo/x"},
		});
	});

	it("reads an explicit null evidenceStore as no store", () => {
		expect(capture({evidenceStore: null})).toMatchObject({
			_tag: "Declared",
			value: {evidenceStore: null},
		});
	});

	it.each([
		[
			"a fractional viewport",
			{viewport: {width: 12.5, height: 900}},
			`"${UI_CAPTURE}.viewport.width" is not a positive integer`,
		],
		["a non-object viewport", {viewport: 3}, `"${UI_CAPTURE}.viewport" is not an object`],
		[
			"an unknown key inside viewport",
			{viewport: {width: 390, height: 844, depth: 2}},
			'unknown key "depth"',
		],
		["an unknown key", {browser: "chromium"}, 'unknown key "browser"'],
		[
			"an absolute storageState",
			{storageState: "/Users/someone/session.json"},
			`"${UI_CAPTURE}.storageState" is not a repo-root-relative path`,
		],
		[
			"an empty storageState",
			{storageState: "   "},
			`"${UI_CAPTURE}.storageState" is not a repo-root-relative path`,
		],
	])("refuses %s whole-value, naming the field it rejected", (_label, value, reason) => {
		expect(capture(value)).toMatchObject({_tag: "Malformed", reason});
	});

	it("refuses a non-object value", () => {
		expect(resolve(load({[UI_CAPTURE]: []}), uiCaptureKey)).toMatchObject({
			_tag: "Malformed",
			reason: `\`${UI_CAPTURE}\` is not an object`,
		});
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
