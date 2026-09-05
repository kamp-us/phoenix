import {type Schema, SchemaAST, SchemaIssue} from "effect";

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

/** A field whose schema is one literal, so its value alone can rule a union member out. */
interface Discriminant {
	readonly key: PropertyKey;
	readonly literal: SchemaAST.LiteralValue;
}

/**
 * Re-derives what `SchemaAST`'s union candidate index reads off a member: the non-optional fields
 * typed as a single literal, taken past the encoding chain, and for a nested union only the ones
 * every one of its members agrees on. `SchemaAST.collectSentinels` does this inside the parser but
 * is `@internal` and absent from the published `.d.ts`, so it is re-derived here off public nodes.
 */
const discriminantsOf = (ast: SchemaAST.AST): ReadonlyArray<Discriminant> => {
	const encoded = ast.encoding?.at(-1);
	if (encoded !== undefined) return discriminantsOf(encoded.to);
	if (SchemaAST.isUnion(ast)) {
		const members = ast.types.map(discriminantsOf);
		const [first] = members;
		if (first === undefined) return [];
		return first.filter((d) =>
			members.every((ds) => ds.some((o) => o.key === d.key && o.literal === d.literal)),
		);
	}
	if (SchemaAST.isObjects(ast)) {
		return ast.propertySignatures.flatMap((ps) =>
			SchemaAST.isLiteral(ps.type) && ps.type.context?.isOptional !== true
				? [{key: ps.name, literal: ps.type.literal}]
				: [],
		);
	}
	return [];
};

const renderValue = (value: unknown): string => {
	const rendered = JSON.stringify(value);
	return rendered === undefined ? String(value) : rendered;
};

/**
 * Which discriminant ruled out the last surviving member, for a union whose candidate index left the
 * parser nothing to try — the `AnyOf` that carries no member issue and formats as a dump of every
 * candidate shape. Narrows in declaration order, so the field it names is the one that eliminated
 * the members still standing, and the values it offers are only theirs.
 */
const unmatchedUnionIssue = (
	ast: SchemaAST.Union,
	input: unknown,
): SchemaIssueSummary | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const record = input as Record<PropertyKey, unknown>;
	let candidates = ast.types.map(discriminantsOf).filter((ds) => ds.length > 0);
	for (const key of new Set(candidates.flatMap((ds) => ds.map((d) => d.key)))) {
		const owned = candidates.flatMap((ds) => ds.filter((d) => d.key === key));
		const present = Object.hasOwn(record, key);
		const survivors = candidates.filter((ds) => {
			const own = ds.find((d) => d.key === key);
			return own === undefined || (present && own.literal === record[key]);
		});
		if (survivors.length > 0) {
			candidates = survivors;
			continue;
		}
		const at = renderPath([key]);
		if (!present) return {expected: "Missing key", at};
		const expected = [...new Set(owned.map((d) => renderValue(d.literal)))].join(" | ");
		return {expected: `Expected ${expected}, got ${renderValue(record[key])}`, at};
	}
	return undefined;
};

/**
 * The first issue of a schema failure. Every decode this app runs answers on the first one.
 *
 * `input` is the value that failed, and it buys one thing: when a union's discriminants rule out
 * every member the failure carries no member issue to be first, and the input is what names the
 * field that did the ruling out (#7760). Only a union at the root of the failure is read this way.
 */
export const firstSchemaIssue = (
	error: Schema.SchemaError,
	input?: unknown,
): SchemaIssueSummary => {
	const {issue} = error;
	if (issue._tag === "AnyOf" && issue.issues.length === 0) {
		const unmatched = unmatchedUnionIssue(issue.ast, input);
		if (unmatched !== undefined) return unmatched;
	}
	const [first] = formatIssues(issue).issues;
	if (first === undefined) return {expected: "does not match the schema", at: ""};
	return {
		expected: first.message,
		at: first.path === undefined ? "" : renderPath(first.path),
	};
};

/**
 * The parameter an `at` blames — its leading segment, or `""` when it blames no single one.
 *
 * The inverse of `renderPath`, and it lives beside it so the two cannot drift: a caller holding a
 * flat record keyed by parameter name has to strip the nesting before it can look the value up,
 * and `renderPath` is the only thing that decides where a name ends. Both separators it can emit
 * end one — `.` before a key, `[` before an index — and a path opening on `[` names an index
 * rather than a parameter, so it blames none.
 */
export const parameterOf = (at: string): string => at.split(/[.[]/, 1)[0] ?? "";

/** The first issue as one line — what was wrong, and where. A refusal interpolates this. */
export const describeSchemaError = (error: Schema.SchemaError, input?: unknown): string => {
	const {expected, at} = firstSchemaIssue(error, input);
	return at.length === 0 ? expected : `${expected} at ${at}`;
};
