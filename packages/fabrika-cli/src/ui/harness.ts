/**
 * `design-harness.json` — how this repo renders and where its evidence lives.
 *
 * The portable replacement for v1's phoenix-hardcoded "alchemy dev" knowledge: the commands, the
 * surface namespace and the readiness probes are the repo's own declaration, so the render leg needs
 * no knowledge of any particular stack. Validated whole-file, the same rule the registry gets.
 *
 * A repo has more than one runnable app (phoenix has two under ADR 0345), so the declaration is a
 * list of apps rather than one server. Each app owns a `mount` — a prefix of the surface namespace —
 * and a surface resolves to the app whose mount is its longest match, never onto one shared base
 * URL. Readiness is per app, so a surface served by a worker-free app goes green the moment that app
 * answers.
 *
 * No app declares a port. A command carries `{{port}}` placeholders the render leg fills with freshly
 * allocated free ports at start, because a fixed port is not a per-worktree resource: two lanes
 * rendering at once would either collide or, worse, capture each other's tree (#7992).
 *
 * `storageState` is the one key naming a file rather than a value: a Playwright storage-state
 * snapshot, so a repo whose surfaces sit behind a login can be rendered as a logged-in user. It is a
 * credential, so it is a path the repo gitignores — never the cookies inline.
 */
import {Effect, Result, Schema, SchemaIssue} from "effect";
import {parseJsonOrReason} from "../io/json.ts";

/** The capture viewport in CSS px, when the harness does not name one. */
export const DEFAULT_VIEWPORT = {width: 1280, height: 900} as const;
/** The readiness bound: an app that has not answered 200 by here leaves its surfaces UNKNOWN. */
export const READY_TIMEOUT_MS = 60_000;

/**
 * The refusal wording, one string per field however that field fails — a missing key, a wrong type
 * and a failed check all read the same. Callers interpolate these into user-facing refusals
 * (`render-verb.ts`, `evidence-verb.ts`) and `harness.unit.test.ts` pins them, so they are the
 * schema's contract rather than incidental text.
 */
const VIOLATION = {
	topLevel: "the top level is not an object",
	/** The unexpected key is only known to the formatter, which fills the placeholder from the path. */
	unknownKey: 'unknown key "%key%"',
	apps: '"apps" is not a non-empty array of app declarations',
	name: '"apps[].name" is missing or is not a kebab-case app name',
	command: '"apps[].command" is missing or not a non-empty string',
	mount: '"apps[].mount" is missing or is not a path beginning with "/"',
	basePath: '"apps[].basePath" is not a path beginning with "/"',
	readyPath: '"apps[].readyPath" is not a path beginning with "/"',
	viewport: '"viewport" is not an object',
	width: '"viewport.width" is not a positive integer',
	height: '"viewport.height" is not a positive integer',
	evidenceStore: '"evidenceStore" is not a string',
	storageState: '"storageState" is not a repo-root-relative path',
} as const;

/**
 * The three violations no per-field check can state, because each is a fact about the list rather
 * than about one value. `harness.unit.test.ts` pins these beside the schema's own.
 */
export const LIST_VIOLATION = {
	noPort: (name: string) =>
		`app "${name}" declares a command with no {{port}} placeholder — a fixed port is not a per-worktree resource`,
	duplicateName: (name: string) => `two apps declare the name "${name}"`,
	duplicateMount: (mount: string) => `two apps declare the mount "${mount}"`,
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

const App = Schema.Struct({
	name: Schema.String.annotate({message: VIOLATION.name})
		.check(Schema.isPattern(KEBAB, {message: VIOLATION.name}))
		.annotateKey({messageMissingKey: VIOLATION.name}),
	command: Schema.String.annotate({message: VIOLATION.command})
		.check(Schema.makeFilter((value) => value.trim() !== "", {message: VIOLATION.command}))
		.annotateKey({messageMissingKey: VIOLATION.command}),
	mount: routePath(VIOLATION.mount),
	basePath: Schema.NullOr(routePath(VIOLATION.basePath))
		.annotate({message: VIOLATION.basePath})
		.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
	readyPath: routePath(VIOLATION.readyPath).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("/")),
	),
}).annotate({message: VIOLATION.apps, messageUnexpectedKey: VIOLATION.unknownKey});

const Harness = Schema.Struct({
	apps: Schema.Array(App)
		.annotate({message: VIOLATION.apps})
		.check(Schema.makeFilter((value) => value.length > 0, {message: VIOLATION.apps}))
		.annotateKey({messageMissingKey: VIOLATION.apps}),
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
}).annotate({message: VIOLATION.topLevel, messageUnexpectedKey: VIOLATION.unknownKey});

export type HarnessConfig = typeof Harness.Type;
export type HarnessApp = HarnessConfig["apps"][number];

export type HarnessParse =
	| {readonly _tag: "Config"; readonly config: HarnessConfig}
	| {readonly _tag: "Violation"; readonly violation: string};

const decodeHarness = Schema.decodeUnknownResult(Harness, {onExcessProperty: "error"});

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: SchemaIssue.defaultLeafHook,
	checkHook: SchemaIssue.defaultCheckHook,
});

const violationOf = (error: Schema.SchemaError): string => {
	const [first] = formatIssues(error.issue).issues;
	if (first === undefined) return VIOLATION.topLevel;
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

const listViolation = (config: HarnessConfig): string | null => {
	const names = new Set<string>();
	const mounts = new Set<string>();
	for (const app of config.apps) {
		if (names.has(app.name)) return LIST_VIOLATION.duplicateName(app.name);
		names.add(app.name);
		if (mounts.has(app.mount)) return LIST_VIOLATION.duplicateMount(app.mount);
		mounts.add(app.mount);
		if (!portTokens(app.command).includes(ORIGIN_PORT)) return LIST_VIOLATION.noPort(app.name);
	}
	return null;
};

export const parseHarness = (text: string): HarnessParse => {
	const parsed = parseJsonOrReason(text);
	if (parsed._tag === "Failed") {
		return {_tag: "Violation", violation: `the file is not JSON (${parsed.reason})`};
	}
	const decoded = decodeHarness(parsed.value);
	if (!Result.isSuccess(decoded)) {
		return {_tag: "Violation", violation: violationOf(decoded.failure)};
	}
	const listed = listViolation(decoded.success);
	return listed === null
		? {_tag: "Config", config: decoded.success}
		: {_tag: "Violation", violation: listed};
};

/** A mount claims a surface on segment boundaries: `/lab` owns `/lab/x`, never `/laboratory`. */
const claims = (mount: string, surface: string): boolean =>
	mount === "/" || surface === mount || surface.startsWith(`${mount}/`);

/** The app serving a surface: the longest claiming mount, or `null` when the namespace has a hole. */
export const appForSurface = (config: HarnessConfig, surface: string): HarnessApp | null =>
	config.apps
		.filter((app) => claims(app.mount, surface))
		.reduce<HarnessApp | null>(
			(best, app) => (best === null || app.mount.length > best.mount.length ? app : best),
			null,
		);

/**
 * The path a surface has on its own app's server: the surface with its mount replaced by the app's
 * `basePath`. `basePath` defaults to the mount, which makes the default an identity — a mount is a
 * namespace, and only an app serving those pages at a different root (a proof server rooted at `/`)
 * has to say so.
 */
export const surfacePath = (app: HarnessApp, surface: string): string => {
	const remainder = app.mount === "/" ? surface : surface.slice(app.mount.length);
	const joined = `${app.basePath ?? app.mount}${remainder}`.replace(/\/{2,}/g, "/");
	return joined === "" ? "/" : joined;
};

/** The URL to navigate for a surface, given the origin its app was started on. */
export const surfaceUrl = (origin: string, app: HarnessApp, surface: string): string =>
	`${origin.replace(/\/+$/, "")}${surfacePath(app, surface)}`;

/** `/` → `root`; every other route becomes its slug (`/pano/yeni` → `pano-yeni`). */
export const surfaceSlug = (route: string): string => {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "root" : trimmed.replace(/\//g, "-");
};
