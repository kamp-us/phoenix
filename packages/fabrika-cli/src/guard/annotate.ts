/**
 * GitHub workflow-command annotations — how a red guard lands on the PR diff instead of in a log
 * dig (#3868). This is the one module that knows the syntax: the location model, the escaping, and
 * the "only under Actions" predicate.
 *
 * A location is a closed union rather than optional `file`/`line` fields, so the state GitHub
 * silently drops — a `line=` with no `file=` — cannot be constructed.
 *
 * **The commands ride on stderr here, where v1 wrote them to stdout.** The runner wires
 * BOTH streams of a `run:` step into an `OutputManager` over the same `ActionCommandManager`
 * (`actions/runner`, `src/Runner.Worker/Handlers/ScriptHandler.cs`: `StepHost.OutputDataReceived`
 * and `StepHost.ErrorDataReceived` both feed one command manager), so a command on stderr is parsed
 * exactly as one on stdout. That is what lets a guard keep fabrika's stdout invariant — a non-zero
 * exit carries NOTHING on stdout (`../verb.ts`) — without losing the annotation.
 */

/** How GitHub renders the finding. */
export type AnnotationLevel = "error" | "warning" | "notice";

/** Where a finding sits: nowhere in particular, a whole file, or one line of it. */
export type AnnotationLocation =
	| {readonly _tag: "Unlocated"}
	| {readonly _tag: "File"; readonly file: string}
	| {readonly _tag: "Line"; readonly file: string; readonly line: number};

export interface Annotation {
	readonly level: AnnotationLevel;
	readonly message: string;
	readonly location: AnnotationLocation;
}

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

// A newline would terminate the command early and a `%` would be read as the start of an existing
// escape, so `%` goes first. This is the toolkit's `toCommandValue` encoding.
const escapeData = (value: string): string =>
	value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// Property values live in the comma-separated `k=v,k=v` head, where `,` ends the property and `:`
// ends the head — both need escaping on top of the data escapes above.
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

/** One annotation as the workflow command GitHub parses off the step's output. */
export const formatWorkflowCommand = (annotation: Annotation): string =>
	`::${annotation.level}${properties(annotation.location)}::${escapeData(annotation.message)}`;

/**
 * Annotations are a CI-only output: locally they are noise a human reads past, and nothing outside
 * Actions parses them. GitHub sets `GITHUB_ACTIONS=true` on every runner, so an explicit `false`
 * (the documented way to signal "not a real runner") turns them back off.
 */
export const annotationsEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => {
	const flag = env.GITHUB_ACTIONS;
	return flag !== undefined && flag !== "" && flag !== "false";
};

/** How much of a multi-line guard report rides in a single fallback annotation. */
const FALLBACK_MESSAGE_LINES = 8;

/**
 * The annotations for a report that supplied none of its own. Every guard's report is human prose;
 * a guard that cannot name a file still gets one bare `::error` so the failure shows up in the
 * checks summary instead of only in the log (#3868).
 */
export const fallbackAnnotations = (
	report: string,
	annotations: ReadonlyArray<Annotation> = [],
): ReadonlyArray<Annotation> => {
	if (annotations.length > 0) return annotations;
	const head = report.trim().split("\n").slice(0, FALLBACK_MESSAGE_LINES).join("\n");
	return head === "" ? [] : [unlocated("error", head)];
};

/** The lines to emit: the workflow commands under Actions, nothing at all anywhere else. */
export const renderAnnotations = (
	annotations: ReadonlyArray<Annotation>,
	env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => (annotationsEnabled(env) ? annotations.map(formatWorkflowCommand) : []);
