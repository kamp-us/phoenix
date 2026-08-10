/**
 * The wire-formats index doc, rendered from the registry and reconciled against it.
 *
 * The doc's per-format projection — owner module, producers, consumers — used to be typed by hand
 * off `./registry.ts`. That is a second source of truth: it agrees until someone lands a format and
 * forgets a line, and the page still reads as authoritative once it stops agreeing (#4968). So the
 * projection is not written by hand at all any more. It is one generated region, rendered here from
 * the rows, and `fabrika wire index --write` is its only writer — a hand edit inside the region is
 * overwritten by the generator and red under the check. What stays hand-written is the half the
 * registry cannot hold: the protocol narrative under each ``### `<key>` `` heading. ADR 0241 keeps
 * the shape out of both.
 *
 * Three divergences are findings rather than silent drift: a registered format with no narrative
 * section, a narrative section for no registered format, and a region whose bytes are not what the
 * registry renders today. Zero scope is a refusal, never a vacuous pass (ADR 0092) — an empty or
 * unreadable doc, a missing marker pair, a doc with no format sections, and an empty registry all
 * refuse, because each would otherwise let the reconciliation report agreement over nothing.
 */
import type {WireFormat} from "./format.ts";

/** The doc this module owns, repo-relative — the one place its location is stated. */
export const DOC_PATH = "claude-plugins/fabrika/docs/wire-formats.md";

export const BEGIN_MARKER = "<!-- fabrika:wire-index:begin -->";
export const END_MARKER = "<!-- fabrika:wire-index:end -->";

/**
 * The hop from the doc back to the repo root, derived from {@link DOC_PATH}.
 *
 * Derived rather than written so a moved doc cannot leave every rendered link pointing at a depth
 * the page no longer sits at.
 */
const TO_ROOT = "../".repeat(DOC_PATH.split("/").length - 1);

const GENERATED_NOTE =
	"<!-- Generated from packages/fabrika-cli/src/wire/registry.ts by `fabrika wire index --write`. Hand edits inside this region are reverted by the generator and red in CI. -->";

/** One narrative section per format: a level-3 heading carrying the registered key in backticks. */
const SECTION_PATTERN = /^###[ \t]+`([^`]+)`[ \t]*$/gm;

export const INDEX_LAWS = {
	documented: "every registered format has a narrative section in the index doc",
	registered: "every narrative section in the index doc names a registered format",
	projection: "the generated region is what the registry renders today",
} as const;

/** One divergence, named against the format (or the doc) that carries it. */
export interface IndexDocFinding {
	readonly subject: string;
	readonly law: string;
	readonly detail: string;
}

export type IndexDocReport =
	| {readonly _tag: "ZeroScope"; readonly reason: string}
	| {
			readonly _tag: "Scanned";
			readonly registered: number;
			readonly documented: number;
			readonly findings: ReadonlyArray<IndexDocFinding>;
	  };

export type IndexDocRewrite =
	| {readonly _tag: "Rewritten"; readonly markdown: string}
	| {readonly _tag: "ZeroScope"; readonly reason: string};

const cell = (names: ReadonlyArray<string>): string =>
	names.length === 0 ? "—" : names.map((name) => `\`${name}\``).join(", ");

/** The region's inner bytes — the whole projection, and the only part of the doc derived from code. */
export const renderProjection = (formats: ReadonlyArray<WireFormat>): string =>
	[
		GENERATED_NOTE,
		"",
		"| Format | Owner module | Producers | Consumers |",
		"| --- | --- | --- | --- |",
		...formats.map(
			({key, module, producers, consumers}) =>
				`| \`${key}\` | [\`${module}\`](${TO_ROOT}${module}) | ${cell(producers)} | ${cell(consumers)} |`,
		),
	].join("\n");

type Region =
	| {
			readonly _tag: "Region";
			readonly inner: string;
			readonly before: string;
			readonly after: string;
	  }
	| {readonly _tag: "Missing"; readonly reason: string};

const locateRegion = (markdown: string): Region => {
	const begin = markdown.indexOf(BEGIN_MARKER);
	const end = markdown.indexOf(END_MARKER);
	if (begin === -1 || end === -1 || end < begin) {
		return {
			_tag: "Missing",
			reason: `${DOC_PATH} carries no ${BEGIN_MARKER} … ${END_MARKER} region — there is nothing to reconcile against the registry`,
		};
	}
	return {
		_tag: "Region",
		before: markdown.slice(0, begin + BEGIN_MARKER.length),
		inner: markdown.slice(begin + BEGIN_MARKER.length, end),
		after: markdown.slice(end),
	};
};

export const documentedKeys = (markdown: string): ReadonlyArray<string> =>
	[...markdown.matchAll(SECTION_PATTERN)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]],
	);

export const conformIndexDoc = (
	markdown: string,
	formats: ReadonlyArray<WireFormat>,
): IndexDocReport => {
	if (formats.length === 0) {
		return {
			_tag: "ZeroScope",
			reason:
				"the registry holds no rows — an index reconciled against zero formats proves nothing (ADR 0092)",
		};
	}
	if (markdown.trim() === "") {
		return {_tag: "ZeroScope", reason: `${DOC_PATH} is empty — nothing was read to reconcile`};
	}

	const region = locateRegion(markdown);
	if (region._tag === "Missing") return {_tag: "ZeroScope", reason: region.reason};

	const documented = documentedKeys(markdown);
	if (documented.length === 0) {
		return {
			_tag: "ZeroScope",
			reason: `${DOC_PATH} parsed to zero format sections — an unparseable page reads as "nothing is documented", which is byte-identical to a page that documents nothing (ADR 0092)`,
		};
	}

	const registered = formats.map((format) => format.key);
	const findings: IndexDocFinding[] = [
		...registered
			.filter((key) => !documented.includes(key))
			.map((key) => ({
				subject: key,
				law: INDEX_LAWS.documented,
				detail: `registered in registry.ts with no \`### \`${key}\`\` section in ${DOC_PATH} — the index under-reports what exists`,
			})),
		...documented
			.filter((key) => !registered.includes(key))
			.map((key) => ({
				subject: key,
				law: INDEX_LAWS.registered,
				detail: `documented in ${DOC_PATH} but registered nowhere — the index points a reader at an owner module that may not exist`,
			})),
	];

	if (region.inner.trim() !== renderProjection(formats).trim()) {
		findings.push({
			subject: DOC_PATH,
			law: INDEX_LAWS.projection,
			detail:
				"the generated region disagrees with the registry — run `fabrika wire index --write` to render it again",
		});
	}

	return {_tag: "Scanned", registered: formats.length, documented: documented.length, findings};
};

/**
 * Render the region again from the registry, leaving every hand-written byte outside it untouched.
 *
 * This writes the projection and nothing else: a format with no narrative section still has none
 * afterwards, because the narrative is the half no registry row holds. {@link conformIndexDoc} keeps
 * reporting that until a human writes the paragraph.
 */
export const rewriteIndexDoc = (
	markdown: string,
	formats: ReadonlyArray<WireFormat>,
): IndexDocRewrite => {
	if (formats.length === 0) {
		return {
			_tag: "ZeroScope",
			reason:
				"the registry holds no rows — rendering an empty table would delete the index rather than derive it (ADR 0092)",
		};
	}
	const region = locateRegion(markdown);
	if (region._tag === "Missing") return {_tag: "ZeroScope", reason: region.reason};

	return {
		_tag: "Rewritten",
		markdown: `${region.before}\n${renderProjection(formats)}\n${region.after}`,
	};
};

/** One line per finding, so a red names what to fix without opening the doc. */
export const describeIndexFindings = (findings: ReadonlyArray<IndexDocFinding>): string =>
	findings.map(({subject, law, detail}) => `${subject}: ${law} — ${detail}`).join("\n");
