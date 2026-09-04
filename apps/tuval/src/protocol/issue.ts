import {type Schema, SchemaIssue} from "effect";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: SchemaIssue.defaultLeafHook,
	checkHook: SchemaIssue.defaultCheckHook,
});

const renderPath = (path: ReadonlyArray<PropertyKey | {readonly key: PropertyKey}>): string =>
	path
		.map((segment) => (typeof segment === "object" ? segment.key : segment))
		.map((key, index) =>
			typeof key === "number" ? `[${key}]` : index === 0 ? String(key) : `.${String(key)}`,
		)
		.join("");

/** What was wrong and where, kept apart: a refusal that renders one line joins them itself. */
export interface SchemaIssueSummary {
	readonly expected: string;
	/** The dotted path inside the value, empty when the whole value is at fault. */
	readonly at: string;
}

/** The first issue of a schema failure. Every decode this app runs answers on the first one. */
export const firstSchemaIssue = (error: Schema.SchemaError): SchemaIssueSummary => {
	const [first] = formatIssues(error.issue).issues;
	if (first === undefined) return {expected: "does not match the schema", at: ""};
	return {
		expected: first.message,
		at: first.path === undefined ? "" : renderPath(first.path),
	};
};

/** The first issue as one line — what was wrong, and where. A refusal interpolates this. */
export const describeSchemaError = (error: Schema.SchemaError): string => {
	const {expected, at} = firstSchemaIssue(error);
	return at.length === 0 ? expected : `${expected} at ${at}`;
};
