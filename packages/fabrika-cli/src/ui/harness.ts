/**
 * `design-harness.json` — how this repo renders and where its evidence lives.
 *
 * The portable replacement for v1's phoenix-hardcoded "alchemy dev" knowledge: the command, the base
 * URL and the readiness probe are the repo's own declaration, so the render leg needs no knowledge of
 * any particular stack. Validated whole-file, the same rule the registry gets.
 */

/** The capture viewport in CSS px, when the harness does not name one. */
export const DEFAULT_VIEWPORT = {width: 1280, height: 900} as const;
/** The readiness bound: a harness that has not answered 200 by here leaves every surface UNKNOWN. */
export const READY_TIMEOUT_MS = 60_000;

export interface HarnessConfig {
	readonly command: string;
	readonly url: string;
	readonly readyPath: string;
	readonly viewport: {readonly width: number; readonly height: number};
	readonly evidenceStore: string | null;
}

export type HarnessParse =
	| {readonly _tag: "Config"; readonly config: HarnessConfig}
	| {readonly _tag: "Violation"; readonly violation: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const KNOWN = ["command", "url", "readyPath", "viewport", "evidenceStore"];

const viewportOf = (raw: unknown): {width: number; height: number} | string => {
	if (raw === undefined) return {...DEFAULT_VIEWPORT};
	if (!isRecord(raw)) return '"viewport" is not an object';
	const {width, height} = raw;
	if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
		return '"viewport.width" is not a positive integer';
	}
	if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
		return '"viewport.height" is not a positive integer';
	}
	return {width, height};
};

export const parseHarness = (text: string): HarnessParse => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {_tag: "Violation", violation: `the file is not JSON (${(err as Error).message})`};
	}
	if (!isRecord(parsed)) return {_tag: "Violation", violation: "the top level is not an object"};
	const extra = Object.keys(parsed).filter((key) => !KNOWN.includes(key));
	if (extra[0] !== undefined) {
		return {_tag: "Violation", violation: `unknown key "${extra[0]}"`};
	}
	if (typeof parsed.command !== "string" || parsed.command.trim() === "") {
		return {_tag: "Violation", violation: '"command" is missing or not a non-empty string'};
	}
	if (typeof parsed.url !== "string" || !/^https?:\/\//.test(parsed.url)) {
		return {_tag: "Violation", violation: '"url" is missing or is not an http(s) base URL'};
	}
	const readyPath = parsed.readyPath ?? "/";
	if (typeof readyPath !== "string" || !readyPath.startsWith("/")) {
		return {_tag: "Violation", violation: '"readyPath" is not a path beginning with "/"'};
	}
	const viewport = viewportOf(parsed.viewport);
	if (typeof viewport === "string") return {_tag: "Violation", violation: viewport};
	const evidenceStore = parsed.evidenceStore;
	if (evidenceStore !== undefined && typeof evidenceStore !== "string") {
		return {_tag: "Violation", violation: '"evidenceStore" is not a string'};
	}
	return {
		_tag: "Config",
		config: {
			command: parsed.command,
			url: parsed.url.replace(/\/+$/, ""),
			readyPath,
			viewport,
			evidenceStore: evidenceStore ?? null,
		},
	};
};

/** `/` → `root`; every other route becomes its slug (`/pano/yeni` → `pano-yeni`). */
export const surfaceSlug = (route: string): string => {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "root" : trimmed.replace(/\//g, "-");
};
