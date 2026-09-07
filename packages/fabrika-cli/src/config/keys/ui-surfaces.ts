/**
 * `uiSurfaces` and `uiCapture` — the runnable apps this repo renders, and how a capture is taken.
 *
 * One row per runnable app. A row carries where the app's rendered source lives
 * (`prefix`), how to start it (`command`), what part of the surface namespace it owns (`mount`,
 * `basePath`) and how to tell it is up (`readyPath`). Two questions read this one list: which changed
 * paths raise the `ui` class (`review/classes.ts`'s `isUiSurface` over the prefixes), and which
 * server a surface is captured from (`ui render`). While the first was a compiled-in source-root
 * literal, a second runnable app's pixels passed every gate unrendered.
 *
 * **The empty list is a declaration, not a silence.** It is also the shipped default, so a repo that
 * declares nothing raises no `ui` class and refuses `ui render` — each in one named sentence
 * ({@link NO_UI_SURFACES}), never by quietly deriving less.
 *
 * No row declares a port. A command carries `{{port}}` placeholders the render leg fills with freshly
 * allocated free ports at start, because a fixed port is not a per-worktree resource: two lanes
 * rendering at once would either collide or, worse, capture each other's tree.
 *
 * `uiCapture` is the list-level half — viewport, evidence store, storage state. `storageState` is the
 * one field naming a file rather than a value: a Playwright storage-state snapshot, so a repo whose
 * surfaces sit behind a login can be rendered as a logged-in user. It is a credential, so it is a
 * path the repo gitignores — never the cookies inline.
 */

import {Effect, Result, Schema, SchemaIssue} from "effect";
import {CONFIG_PATH} from "../document.ts";
import type {JsonSchema} from "../json-schema.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const UI_SURFACES = "uiSurfaces";
export const UI_CAPTURE = "uiCapture";

/** The capture viewport in CSS px, when `uiCapture` names none. */
export const DEFAULT_VIEWPORT = {width: 1280, height: 900} as const;

/**
 * The one sentence every reader of an empty list prints — the scope verbs on stderr, `ui render` and
 * `ui evidence` as their refusal. Shared so "this repo has no rendered gate" reads the same wherever
 * it is stated.
 */
export const NO_UI_SURFACES = `${CONFIG_PATH} declares no \`${UI_SURFACES}\` rows — this repo declares no rendered surface, so no path raises the ui class and nothing can be rendered headlessly`;

/**
 * The refusal wording, one string per field however that field fails — a missing key, a wrong type
 * and a failed check all read the same. Callers interpolate these into user-facing refusals and
 * `ui-surfaces.unit.test.ts` pins them, so they are the schema's contract rather than incidental text.
 */
const VIOLATION = {
	list: `\`${UI_SURFACES}\` is not an array of surface declarations`,
	capture: `\`${UI_CAPTURE}\` is not an object`,
	/** The unexpected key is only known to the formatter, which fills the placeholder from the path. */
	unknownKey: 'unknown key "%key%"',
	name: `"${UI_SURFACES}[].name" is missing or is not a kebab-case app name`,
	command: `"${UI_SURFACES}[].command" is missing or not a non-empty string`,
	prefix: `"${UI_SURFACES}[].prefix" is missing or is not a repo-relative directory prefix ending in "/"`,
	mount: `"${UI_SURFACES}[].mount" is missing or is not a path beginning with "/"`,
	basePath: `"${UI_SURFACES}[].basePath" is not a path beginning with "/"`,
	readyPath: `"${UI_SURFACES}[].readyPath" is not a path beginning with "/"`,
	viewport: `"${UI_CAPTURE}.viewport" is not an object`,
	width: `"${UI_CAPTURE}.viewport.width" is not a positive integer`,
	height: `"${UI_CAPTURE}.viewport.height" is not a positive integer`,
	evidenceStore: `"${UI_CAPTURE}.evidenceStore" is not a string`,
	storageState: `"${UI_CAPTURE}.storageState" is not a repo-root-relative path`,
} as const;

/**
 * The three violations no per-field check can state, because each is a fact about the list rather
 * than about one value.
 *
 * A repeated `prefix` is deliberately absent: two apps legitimately serve one source root — an app
 * and its component lab commonly sit under one prefix.
 */
export const LIST_VIOLATION = {
	noPort: (name: string) =>
		`surface "${name}" declares a command with no {{port}} placeholder — a fixed port is not a per-worktree resource`,
	duplicateName: (name: string) => `two surfaces declare the name "${name}"`,
	duplicateMount: (mount: string) => `two surfaces declare the mount "${mount}"`,
} as const;

const KEY_PLACEHOLDER = "%key%";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `{{port}}` and `{{port:<name>}}` — every distinct token in one command gets one freshly allocated
 * free port, and the unnamed token is the app's own origin port.
 */
const PORT_TOKEN = /\{\{port(?::([a-z0-9]+(?:-[a-z0-9]+)*))?\}\}/g;

/** The name of the unnamed `{{port}}` token: the port the app's own origin is built from. */
export const ORIGIN_PORT = "";

const positiveInt = (message: string) =>
	Schema.Number.annotate({message})
		.check(Schema.isInt({message}).abort(), Schema.isGreaterThan(0, {message}))
		.annotateKey({messageMissingKey: message});

const routePath = (message: string) =>
	Schema.String.annotate({message})
		.check(Schema.isStartsWith("/", {message}))
		.annotateKey({messageMissingKey: message});

const Viewport = Schema.Struct({
	width: positiveInt(VIOLATION.width),
	height: positiveInt(VIOLATION.height),
})
	.annotate({message: VIOLATION.viewport, messageUnexpectedKey: VIOLATION.unknownKey})
	.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({...DEFAULT_VIEWPORT})));

/** A repo-relative source root: never absolute, never parent-relative, and ending at a directory. */
const isPrefix = (value: string): boolean =>
	value.trim() !== "" &&
	!value.startsWith("/") &&
	!value.startsWith("..") &&
	value.endsWith("/") &&
	value === value.trim();

const Surface = Schema.Struct({
	name: Schema.String.annotate({message: VIOLATION.name})
		.check(Schema.isPattern(KEBAB, {message: VIOLATION.name}))
		.annotateKey({messageMissingKey: VIOLATION.name}),
	command: Schema.String.annotate({message: VIOLATION.command})
		.check(Schema.makeFilter((value) => value.trim() !== "", {message: VIOLATION.command}))
		.annotateKey({messageMissingKey: VIOLATION.command}),
	prefix: Schema.String.annotate({message: VIOLATION.prefix})
		.check(Schema.makeFilter(isPrefix, {message: VIOLATION.prefix}))
		.annotateKey({messageMissingKey: VIOLATION.prefix}),
	mount: routePath(VIOLATION.mount),
	basePath: Schema.NullOr(routePath(VIOLATION.basePath))
		.annotate({message: VIOLATION.basePath})
		.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
	readyPath: routePath(VIOLATION.readyPath).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("/")),
	),
}).annotate({message: VIOLATION.list, messageUnexpectedKey: VIOLATION.unknownKey});

const SurfaceList = Schema.Array(Surface).annotate({message: VIOLATION.list});

const Capture = Schema.Struct({
	viewport: Viewport,
	evidenceStore: Schema.NullOr(Schema.String)
		.annotate({message: VIOLATION.evidenceStore})
		.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
	storageState: Schema.NullOr(
		Schema.String.check(
			Schema.makeFilter((value) => value.trim() !== "" && !value.startsWith("/"), {
				message: VIOLATION.storageState,
			}),
		),
	)
		.annotate({message: VIOLATION.storageState})
		.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
}).annotate({message: VIOLATION.capture, messageUnexpectedKey: VIOLATION.unknownKey});

/** One runnable app: where its source lives, how to start it, and what it serves. */
export type UiSurface = typeof Surface.Type;
/** The list-level capture settings — viewport, evidence store, storage state. */
export type UiCapture = typeof Capture.Type;

const decodeList = Schema.decodeUnknownResult(SurfaceList, {onExcessProperty: "error"});
const decodeCapture = Schema.decodeUnknownResult(Capture, {onExcessProperty: "error"});

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: SchemaIssue.defaultLeafHook,
	checkHook: SchemaIssue.defaultCheckHook,
});

const violationOf = (error: Schema.SchemaError, fallback: string): string => {
	const [first] = formatIssues(error.issue).issues;
	if (first === undefined) return fallback;
	const segment = first.path?.at(-1);
	return first.message.replace(
		KEY_PLACEHOLDER,
		String(typeof segment === "object" ? segment.key : segment),
	);
};

/** Every distinct port token in a command, `ORIGIN_PORT` standing for the unnamed one. */
export const portTokens = (command: string): ReadonlyArray<string> => {
	const names = new Set<string>();
	for (const match of command.matchAll(PORT_TOKEN)) names.add(match[1] ?? ORIGIN_PORT);
	return [...names];
};

/** Fill a command's port tokens from an allocation keyed by `portTokens`' names. */
export const fillPorts = (command: string, ports: ReadonlyMap<string, number>): string =>
	command.replace(PORT_TOKEN, (token, name: string | undefined) => {
		const port = ports.get(name ?? ORIGIN_PORT);
		return port === undefined ? token : String(port);
	});

const listViolation = (surfaces: ReadonlyArray<UiSurface>): string | null => {
	const names = new Set<string>();
	const mounts = new Set<string>();
	for (const surface of surfaces) {
		if (names.has(surface.name)) return LIST_VIOLATION.duplicateName(surface.name);
		names.add(surface.name);
		if (mounts.has(surface.mount)) return LIST_VIOLATION.duplicateMount(surface.mount);
		mounts.add(surface.mount);
		if (!portTokens(surface.command).includes(ORIGIN_PORT)) {
			return LIST_VIOLATION.noPort(surface.name);
		}
	}
	return null;
};

const decodeSurfaces = (raw: unknown): Decoded<ReadonlyArray<UiSurface>> => {
	// The schema's own array message never fires on a non-array top level, so the shape is checked
	// here where the key's name can be named in the refusal.
	if (!Array.isArray(raw)) return {_tag: "Malformed", reason: VIOLATION.list};
	const decoded = decodeList(raw);
	if (!Result.isSuccess(decoded)) {
		return {_tag: "Malformed", reason: violationOf(decoded.failure, VIOLATION.list)};
	}
	const listed = listViolation(decoded.success);
	return listed === null
		? {_tag: "Value", value: decoded.success}
		: {_tag: "Malformed", reason: listed};
};

/** The repo-relative source roots the declared surfaces cover, deduplicated in declaration order. */
export const prefixesOf = (surfaces: ReadonlyArray<UiSurface>): ReadonlyArray<string> => [
	...new Set(surfaces.map((surface) => surface.prefix)),
];

const surfaceSchema: JsonSchema = {
	type: "object",
	description:
		"One runnable app: where its rendered source lives, how to start it, and what it serves.",
	properties: {
		name: {
			type: "string",
			description: "Kebab-case app name, unique across the list.",
			pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
		},
		prefix: {
			type: "string",
			description:
				"The repo-relative source root whose changed files raise the ui class, ending in `/`.",
			minLength: 1,
			pattern: "^(?!/)(?!\\.\\.).*/$",
		},
		mount: {
			type: "string",
			description: "The prefix of the surface namespace this app owns, unique across the list.",
			pattern: "^/",
		},
		basePath: {
			type: ["string", "null"],
			description:
				"Where this app serves its mounted pages, when that is not the mount itself. Defaults to the mount.",
			pattern: "^/",
		},
		command: {
			type: "string",
			description:
				"The shell command that starts the app. Must carry a bare `{{port}}` placeholder; `{{port:<name>}}` allocates further ports.",
			minLength: 1,
		},
		readyPath: {
			type: "string",
			description: "The path polled for a 200 before any capture. Defaults to `/`.",
			pattern: "^/",
		},
	},
	required: ["name", "prefix", "mount", "command"],
	additionalProperties: false,
};

export const uiSurfacesKey: KeyGroup<ReadonlyArray<UiSurface>> = {
	key: UI_SURFACES,
	// Empty, and stated: a repo that declares nothing has no rendered gate rather than someone else's.
	shippedDefault: [],
	decode: decodeSurfaces,
	jsonSchema: {
		type: "array",
		description:
			"The runnable apps this repo renders, one row per app. An empty list means no rendered gate: no path raises the ui class and `ui render` refuses.",
		items: surfaceSchema,
	},
};

const SHIPPED_CAPTURE: UiCapture = {
	viewport: {...DEFAULT_VIEWPORT},
	evidenceStore: null,
	storageState: null,
};

export const uiCaptureKey: KeyGroup<UiCapture> = {
	key: UI_CAPTURE,
	shippedDefault: SHIPPED_CAPTURE,
	decode: (raw) => {
		const decoded = decodeCapture(raw);
		return Result.isSuccess(decoded)
			? {_tag: "Value", value: decoded.success}
			: {_tag: "Malformed", reason: violationOf(decoded.failure, VIOLATION.capture)};
	},
	jsonSchema: {
		type: "object",
		description:
			"How a capture of a `uiSurfaces` row is taken: the viewport, where evidence is hosted, and the storage state to browse as.",
		properties: {
			viewport: {
				type: "object",
				description: `The capture viewport in CSS px. Defaults to ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}.`,
				properties: {
					width: {type: "integer", description: "Viewport width in CSS px."},
					height: {type: "integer", description: "Viewport height in CSS px."},
				},
				required: ["width", "height"],
				additionalProperties: false,
			},
			evidenceStore: {
				type: ["string", "null"],
				description:
					"The evidence store captures are uploaded to. Null (or absent) hosts evidence on GitHub as an attachment.",
			},
			storageState: {
				type: ["string", "null"],
				description:
					"A repo-relative Playwright storage-state file to browse as. It is a credential — gitignore it, never inline the cookies.",
				minLength: 1,
				pattern: "^(?!/).+",
			},
		},
		required: [],
		additionalProperties: false,
	},
};
