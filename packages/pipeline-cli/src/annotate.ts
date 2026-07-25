/**
 * GitHub workflow-command annotations — the pure core behind "a red guard lands on the
 * PR diff, not in a log dig" (#3868).
 *
 * GitHub renders an inline PR annotation for any step that writes a workflow command on
 * stdout (`::error file=<path>,line=<n>::<message>`). This module is the one place that
 * knows that syntax: the location model, the escaping, and the "only under Actions"
 * predicate. `gate-fail.ts` is the thin Effect side that writes what this renders.
 *
 * A location is a closed union rather than optional `file`/`line` fields, so the state
 * GitHub silently drops — a `line=` with no `file=` — cannot be constructed.
 */
import * as Schema from "effect/Schema";

export const AnnotationLevel = Schema.Literals(["error", "warning", "notice"]);
export type AnnotationLevel = typeof AnnotationLevel.Type;

/** Where a finding sits: nowhere in particular, a whole file, or one line of it. */
export const AnnotationLocation = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("Unlocated")}),
	Schema.Struct({_tag: Schema.Literal("File"), file: Schema.String}),
	Schema.Struct({_tag: Schema.Literal("Line"), file: Schema.String, line: Schema.Int}),
]);
export type AnnotationLocation = typeof AnnotationLocation.Type;

export const Annotation = Schema.Struct({
	level: AnnotationLevel,
	message: Schema.String,
	location: AnnotationLocation,
});
export type Annotation = typeof Annotation.Type;

export const unlocated = (level: AnnotationLevel, message: string): Annotation => ({
	level,
	message,
	location: {_tag: "Unlocated"},
});

export const atFile = (level: AnnotationLevel, file: string, message: string): Annotation => ({
	level,
	message,
	location: {_tag: "File", file},
});

export const atLine = (
	level: AnnotationLevel,
	file: string,
	line: number,
	message: string,
): Annotation => ({level, message, location: {_tag: "Line", file, line}});

// A newline would terminate the command early and a `%` would be read as the start of an
// existing escape, so `%` goes first. This is the toolkit's `toCommandValue` encoding.
const escapeData = (value: string): string =>
	value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// Property values live in the comma-separated `k=v,k=v` head, where `,` ends the property
// and `:` ends the head — both need escaping on top of the data escapes above.
const escapeProperty = (value: string): string =>
	escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

const properties = (location: AnnotationLocation): string => {
	switch (location._tag) {
		case "Unlocated":
			return "";
		case "File":
			return ` file=${escapeProperty(location.file)}`;
		case "Line":
			return ` file=${escapeProperty(location.file)},line=${location.line}`;
	}
};

/** Render one annotation as the workflow command GitHub parses off stdout. */
export const formatWorkflowCommand = (annotation: Annotation): string =>
	`::${annotation.level}${properties(annotation.location)}::${escapeData(annotation.message)}`;

/**
 * Annotations are a CI-only output: locally they would be noise a human has to read past,
 * and nothing outside Actions parses them. GitHub sets `GITHUB_ACTIONS=true` on every
 * runner, so an explicit `false` (the documented way to signal "not a real runner") turns
 * them back off.
 */
export const annotationsEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => {
	const flag = env.GITHUB_ACTIONS;
	return flag !== undefined && flag !== "" && flag !== "false";
};

/**
 * The lines to write on a fail path: the workflow commands under Actions, nothing at all
 * anywhere else. Callers write these to stdout verbatim.
 */
export const renderAnnotations = (
	annotations: ReadonlyArray<Annotation>,
	env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => (annotationsEnabled(env) ? annotations.map(formatWorkflowCommand) : []);

/** Bound how much of a multi-line guard report rides in a single fallback annotation. */
const FALLBACK_MESSAGE_LINES = 8;

/**
 * The annotations for a gate failure that supplied none of its own. Every guard's report
 * is human-prose on stderr; a guard that cannot name a file still gets one bare `::error`
 * so the failure shows up in the checks summary instead of only in the log (#3868).
 */
export const gateFailureAnnotations = (
	reason: string,
	annotations: ReadonlyArray<Annotation> = [],
): ReadonlyArray<Annotation> => {
	if (annotations.length > 0) return annotations;
	const head = reason.trim().split("\n").slice(0, FALLBACK_MESSAGE_LINES).join("\n");
	return head === "" ? [] : [unlocated("error", head)];
};
