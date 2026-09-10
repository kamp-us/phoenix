/** The initial audit research record. Recommendations are data; rulings live in comments. */
import {createHash} from "node:crypto";
import {Result, Schema} from "effect";
import type {WireEmit, WireRead, WireReadLines} from "./format.ts";

const Text = Schema.String.check(Schema.isPattern(/\S/));
const Texts = Schema.Array(Text);
const RunId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$/)).pipe(
	Schema.brand("AuditRunId"),
);
const Finding = Schema.Struct({
	id: Text,
	workflow: Text,
	friction: Text,
	evidence: Schema.NonEmptyArray(Text),
	locations: Schema.NonEmptyArray(Text),
	uncertainty: Text,
	counterargument: Text,
	severity: Text,
	ranking: Text,
	recommendation: Text,
	dependencyCategory: Text,
	benefit: Text,
	ownership: Text,
	uncoveredScope: Text,
});

export const AuditContext = Schema.Struct({
	version: Schema.Literal(1),
	runId: RunId,
	repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
	folder: Text,
	revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
	date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
	predecessor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
	findings: Schema.NonEmptyArray(Finding),
	disproven: Schema.Array(Schema.Struct({suspicion: Text, disposition: Text})),
	accounting: Schema.Struct({
		openedFiles: Schema.NonEmptyArray(Text),
		searches: Texts,
		coverage: Texts,
		limits: Texts,
	}),
	firstQuestion: Schema.Struct({findingId: Text, question: Text, recommendation: Text}),
});
export type AuditContext = typeof AuditContext.Type;

export const HEADING = "## Audit context";
export const BODY_LIMIT = 60_000;
const decode = Schema.decodeUnknownResult(Schema.fromJsonString(AuditContext), {
	onExcessProperty: "error",
});

export const parse = (text: string): WireRead<AuditContext> => {
	const parsed = decode(text);
	if (Result.isFailure(parsed)) {
		return {_tag: "Malformed", reason: String(parsed.failure), evidence: text};
	}
	const context = parsed.success;
	const ids = new Set(context.findings.map((finding) => finding.id));
	if (ids.size !== context.findings.length || !ids.has(context.firstQuestion.findingId)) {
		return {
			_tag: "Malformed",
			reason: "finding ids must be unique and the first question must name one",
			evidence: text,
		};
	}
	if (context.folder.startsWith("/") || context.folder.split("/").includes("..")) {
		return {_tag: "Malformed", reason: "folder must be repository-relative", evidence: text};
	}
	return {_tag: "Found", value: context};
};

const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
};

export const digest = (context: AuditContext): string =>
	createHash("sha256")
		.update(JSON.stringify(canonical(context)))
		.digest("hex");

export const emit = (context: AuditContext): string =>
	`${HEADING}\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n${context.predecessor === null ? "" : `\nPrevious audit: https://github.com/${context.repository}/issues/${context.predecessor}\n`}`;

export const read = (body: string): WireRead<AuditContext> => {
	const headings = body.split("\n").filter((line) => /^\s*#{1,6}\s+audit\s*context/i.test(line));
	if (headings.length === 0) return {_tag: "Absent", reason: "no audit context heading"};
	if (headings.length !== 1 || headings[0] !== HEADING) {
		return {
			_tag: "Malformed",
			reason: "audit context heading is drifted or repeated",
			evidence: headings.join("\n"),
		};
	}
	const section = body.slice(body.indexOf(HEADING) + HEADING.length);
	const match = /^\n\n```json\n([\s\S]*?)\n```(?:\n|$)/.exec(section);
	if (match === null)
		return {_tag: "Malformed", reason: "audit context must hold one JSON block", evidence: section};
	return parse(match[1] ?? "");
};

export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parse(fields);
	return parsed._tag === "Found"
		? {_tag: "Composed", bytes: emit(parsed.value)}
		: {_tag: "Unusable", reason: parsed.reason};
};

export const readToLines = (body: string): WireReadLines => {
	const parsed = read(body);
	return parsed._tag === "Found" ? {_tag: "Found", value: [JSON.stringify(parsed.value)]} : parsed;
};
