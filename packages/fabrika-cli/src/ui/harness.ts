/**
 * `design-harness.json` — how this repo renders and where its evidence lives.
 *
 * The portable replacement for v1's phoenix-hardcoded "alchemy dev" knowledge: the command, the base
 * URL and the readiness probe are the repo's own declaration, so the render leg needs no knowledge of
 * any particular stack. Validated whole-file, the same rule the registry gets.
 */
import {Effect, Result, Schema, SchemaGetter, SchemaIssue} from "effect";
import {parseJsonOrReason} from "../io/json.ts";

/** The capture viewport in CSS px, when the harness does not name one. */
export const DEFAULT_VIEWPORT = {width: 1280, height: 900} as const;
/** The readiness bound: a harness that has not answered 200 by here leaves every surface UNKNOWN. */
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
	command: '"command" is missing or not a non-empty string',
	url: '"url" is missing or is not an http(s) base URL',
	readyPath: '"readyPath" is not a path beginning with "/"',
	viewport: '"viewport" is not an object',
	width: '"viewport.width" is not a positive integer',
	height: '"viewport.height" is not a positive integer',
	evidenceStore: '"evidenceStore" is not a string',
} as const;

const KEY_PLACEHOLDER = "%key%";

const positiveInt = (message: string) =>
	Schema.Number.annotate({message})
		.check(Schema.isInt({message}).abort(), Schema.isGreaterThan(0, {message}))
		.annotateKey({messageMissingKey: message});

const Viewport = Schema.Struct({
	width: positiveInt(VIOLATION.width),
	height: positiveInt(VIOLATION.height),
})
	.annotate({message: VIOLATION.viewport, messageUnexpectedKey: VIOLATION.unknownKey})
	.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({...DEFAULT_VIEWPORT})));

const Harness = Schema.Struct({
	command: Schema.String.annotate({message: VIOLATION.command})
		.check(Schema.makeFilter((value) => value.trim() !== "", {message: VIOLATION.command}))
		.annotateKey({messageMissingKey: VIOLATION.command}),
	url: Schema.String.annotate({message: VIOLATION.url})
		.check(Schema.isPattern(/^https?:\/\//, {message: VIOLATION.url}))
		.annotateKey({messageMissingKey: VIOLATION.url})
		.pipe(
			Schema.decode({
				decode: SchemaGetter.transform((url: string) => url.replace(/\/+$/, "")),
				encode: SchemaGetter.passthrough(),
			}),
		),
	readyPath: Schema.String.annotate({message: VIOLATION.readyPath})
		.check(Schema.isStartsWith("/", {message: VIOLATION.readyPath}))
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed("/"))),
	viewport: Viewport,
	evidenceStore: Schema.NullOr(Schema.String)
		.annotate({message: VIOLATION.evidenceStore})
		.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
}).annotate({message: VIOLATION.topLevel, messageUnexpectedKey: VIOLATION.unknownKey});

export type HarnessConfig = typeof Harness.Type;

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

export const parseHarness = (text: string): HarnessParse => {
	const parsed = parseJsonOrReason(text);
	if (parsed._tag === "Failed") {
		return {_tag: "Violation", violation: `the file is not JSON (${parsed.reason})`};
	}
	const decoded = decodeHarness(parsed.value);
	return Result.isSuccess(decoded)
		? {_tag: "Config", config: decoded.success}
		: {_tag: "Violation", violation: violationOf(decoded.failure)};
};

/** `/` → `root`; every other route becomes its slug (`/pano/yeni` → `pano-yeni`). */
export const surfaceSlug = (route: string): string => {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "root" : trimmed.replace(/\//g, "-");
};
