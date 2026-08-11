/**
 * The verdict marker — the recognizable first line of a gate's verdict comment on a PR.
 *
 *     review-code: PASS @ 03135b91 — merge-ready
 *
 * Four fields: the gate **namespace**, the **polarity**, the **head SHA the reviewer inspected**,
 * and the trailing human clause. The SHA is the load-bearing one. A verdict attests the exact tree
 * it was formed over, so a marker bound to a head that has since moved is *stale*, not passing — and
 * a marker carrying no SHA at all is malformed, not passing either. Both are refusals here rather
 * than values a caller could mistake for a current PASS: {@link read} never yields a `Found` with an
 * empty SHA (the type forbids it — {@link HeadSha} has no empty inhabitant), and {@link bindToHead}
 * answers the staleness question as its own third outcome instead of folding it into the read.
 *
 * `read` is total and its three answers are the design (see `./format.ts`). The discrimination that
 * carries the weight is **Absent vs Malformed**: bytes carrying no marker of this format at all are
 * `Absent`; bytes carrying something recognisably *reaching* for one — the namespace is there but
 * the polarity is unknown, the SHA is missing or not hex, the clause is gone — are `Malformed`. A
 * gate whose marker drifted must never read as a PR nobody reviewed.
 *
 * v1's `claude-plugins/kampus-pipeline/skills/shared/gate-verdict-contract.md` §VERDICT and
 * `packages/pipeline-cli/src/tools/verdict/verdict-match.ts` are where the semantics and the scars
 * come from — read as prior art, never called (ADR 0238). v1's upsert keying, its advisory line and
 * its read-back guard are deliberately not carried here.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const HEAD_SHA: unique symbol;
declare const CLAUSE: unique symbol;

/**
 * A git object name the marker is bound to: 7–40 hex characters, lowercased.
 *
 * Branded so a `Found` cannot carry `""`. The abbreviation floor is 7 because that is what git
 * itself abbreviates to and what v1's scanner accepted; shorter is ambiguous across a real
 * repository, and an ambiguous binding is not a binding.
 */
export type HeadSha = string & {readonly [HEAD_SHA]: true};

/** The trailing human clause. Branded for the same reason: a blank clause is not a clause. */
export type Clause = string & {readonly [CLAUSE]: true};

/** The reviewer's go/no-go. A third token is not a polarity — it is a drift. */
export type Polarity = "PASS" | "FAIL";

export interface VerdictMarker {
	/**
	 * The gate that formed the verdict: `review`, `review-<gate>`, `check-epic-plan`, or
	 * `governance`.
	 */
	readonly namespace: string;
	readonly polarity: Polarity;
	readonly sha: HeadSha;
	readonly clause: Clause;
}

export type VerdictMarkerRead = WireRead<VerdictMarker>;

const SHA_MIN = 7;
const SHA_MAX = 40;

/**
 * The gates this format serves: the `review` family, `check-epic-plan`, and `governance`.
 *
 * Each widening is additive — no existing marker's reading changes — and each namespace is its own
 * family rather than a `review-<gate>` member, because a verdict wearing another gate's namespace is
 * the family confusion the partition ruling removed (#4891). `governance` is admitted here (#5199)
 * ahead of the verb that will emit it: `ship scope` already derives it as a required namespace, so a
 * format that cannot carry it makes every governance-root PR permanently `blocked` at `ship gate`.
 * Nothing here grants emission authority — `review post` still refuses any namespace this PR's diff
 * did not derive, and `governance` is not in that image.
 */
const NAMESPACE = /^(review|check-epic-plan|governance)(-[a-z0-9]+)*$/;
/**
 * The prefixes {@link read}'s first gate admits, which must widen with {@link NAMESPACE} or the
 * format can emit a marker it can never read back — the gate runs *before* the regex is ever tested.
 */
const NAMESPACE_PREFIXES = ["review", "check-epic-plan", "governance"];
const HEX = /^[0-9a-f]+$/;

/** The conforming separator between the SHA and the clause; the ASCII dashes are read tolerantly. */
export const CLAUSE_SEPARATOR = "—";
const SEPARATOR = /^(?:—|–|--|-)\s*/;

/**
 * The emphasis a skill's bolding adds, and the `<namespace>:` prefix.
 *
 * The namespace class is deliberately wider than {@link NAMESPACE}: a token this admits and
 * {@link NAMESPACE} rejects becomes a `Malformed` naming the drift, one this turns away becomes an
 * `Absent`. Erring wide is what keeps `review_code:` from being reported as "no verdict here".
 */
const MARKER_LINE = /^\s*(\*{0,2})\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

export const headSha = (raw: string): HeadSha | null => {
	const value = raw.trim().toLowerCase();
	if (value.length < SHA_MIN || value.length > SHA_MAX || !HEX.test(value)) return null;
	return value as HeadSha;
};

export const clause = (raw: string): Clause | null => {
	const value = raw.trim();
	return value === "" ? null : (value as Clause);
};

const polarityOf = (token: string): Polarity | null => {
	const value = token.toUpperCase();
	return value === "PASS" || value === "FAIL" ? value : null;
};

const malformed = (reason: string, evidence: string): VerdictMarkerRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** The marker is the artifact's first non-blank line — a marker merely quoted further down is not one. */
const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

const takeToken = (rest: string): {readonly token: string; readonly after: string} => {
	const trimmed = rest.trimStart();
	const end = trimmed.search(/\s/);
	return end === -1
		? {token: trimmed, after: ""}
		: {token: trimmed.slice(0, end), after: trimmed.slice(end)};
};

/**
 * Read the verdict marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * The walk is stepwise rather than one regex so each refusal can name *which* field drifted; a
 * single alternation would collapse "no SHA" and "unknown polarity" into one unhelpful non-match,
 * and telling a reviewer which half of its own marker is wrong is the whole value of the refusal.
 */
export const read = (artifact: string): VerdictMarkerRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null) {
		return {_tag: "Absent", reason: "the artifact holds no non-blank line to carry a marker"};
	}

	const matched = MARKER_LINE.exec(line);
	const namespace = matched?.[2]?.toLowerCase() ?? "";
	const reaches = NAMESPACE_PREFIXES.some((prefix) => namespace.startsWith(prefix));
	if (matched === undefined || matched === null || !reaches) {
		return {
			_tag: "Absent",
			reason:
				'the first line does not open with a "review…:", "check-epic-plan…:" or "governance…:" namespace — no marker of this format',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	if (!NAMESPACE.test(namespace)) {
		return malformed(
			`the gate namespace "${namespace}" is not kebab-case "review", "review-<gate>", "check-epic-plan" or "governance"`,
			evidence,
		);
	}

	const emphasis = matched[1] ?? "";
	const rest = matched[3] ?? "";
	const {token: polarityToken, after: afterPolarity} = takeToken(rest);
	if (polarityToken === "") {
		return malformed(`"${namespace}:" carries no polarity — expected PASS or FAIL`, evidence);
	}
	const polarity = polarityOf(polarityToken);
	if (polarity === null) {
		return malformed(`"${polarityToken}" is not a polarity — expected PASS or FAIL`, evidence);
	}

	const bound = afterPolarity.trimStart();
	if (!bound.startsWith("@")) {
		return malformed(
			`the ${polarity} marker is bound to no head SHA — a verdict with no "@ <sha>" attests no tree`,
			evidence,
		);
	}
	const {token: shaToken, after: afterSha} = takeToken(bound.slice(1));
	if (shaToken === "") {
		return malformed(
			`the ${polarity} marker's "@" is followed by no SHA — a verdict with no head attests no tree`,
			evidence,
		);
	}
	const sha = headSha(shaToken);
	if (sha === null) {
		return malformed(
			`"${shaToken}" is not a head SHA — expected ${SHA_MIN}–${SHA_MAX} hex characters`,
			evidence,
		);
	}

	// A skill that bolds the whole marker closes it after the clause, so that closer belongs to the
	// emphasis rather than to the human's sentence. Stripped only when the line opened with one.
	const tail = afterSha.trim();
	const unemphasized =
		emphasis !== "" && tail.endsWith(emphasis) ? tail.slice(0, -emphasis.length) : tail;
	const text = clause(unemphasized.replace(SEPARATOR, ""));
	if (text === null) {
		return malformed(
			"the marker carries no trailing clause — the one field that says what the verdict means to a human",
			evidence,
		);
	}

	return {_tag: "Found", value: {namespace, polarity, sha, clause: text}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({namespace, polarity, sha, clause: text}: VerdictMarker): string =>
	`${namespace}: ${polarity} @ ${sha} ${CLAUSE_SEPARATOR} ${text}\n`;

/**
 * Whether a marker is bound to the head a caller holds — the question the SHA field exists for.
 *
 * Deliberately **not** an outcome of {@link read}: staleness is not a property of the bytes, it is a
 * relation between the marker and a head only the caller knows. Equally deliberately three answers
 * rather than a boolean — a caller handed a head it could not resolve gets `Unbindable`, never
 * `Stale` and never `Current`, because a comparison that could not be made is not a negative result.
 * Fold any two of these together and a stale PASS reads as a current one (ADR 0058).
 */
export type Binding =
	| {readonly _tag: "Current"; readonly sha: HeadSha}
	| {readonly _tag: "Stale"; readonly markerSha: HeadSha; readonly head: HeadSha}
	| {readonly _tag: "Unbindable"; readonly reason: string};

/**
 * Whether two head SHAs name the same commit. Either side may be abbreviated, so the match is a
 * prefix in whichever direction is shorter.
 *
 * Exported because {@link bindToHead} is not the only caller: `eval-record.ts` asks the same question
 * of a payload against its own marker line. One copy, so the prefix rule cannot drift between them.
 */
export const sameHead = (a: HeadSha, b: HeadSha): boolean => a.startsWith(b) || b.startsWith(a);

export const bindToHead = (marker: VerdictMarker, head: string): Binding => {
	const resolved = headSha(head);
	if (resolved === null) {
		return {
			_tag: "Unbindable",
			reason: `"${head.trim()}" is not a head SHA — the marker's binding cannot be judged`,
		};
	}
	return sameHead(marker.sha, resolved)
		? {_tag: "Current", sha: marker.sha}
		: {_tag: "Stale", markerSha: marker.sha, head: resolved};
};

export type VerdictMarkerFields =
	| {readonly _tag: "Fields"; readonly marker: VerdictMarker}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["namespace", "polarity", "sha", "clause"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/**
 * Parse `emit`'s stdin into a marker: one `<key>: <value>` per line, in any order.
 *
 * Every rejection here is a refusal rather than a default. A missing `sha` that silently composed
 * an unbound marker, or an unknown key silently dropped, is how a caller emits a verdict weaker than
 * the one it wrote — and the emitted bytes would look perfectly well-formed.
 */
export const parseFields = (fields: string): VerdictMarkerFields => {
	const seen = new Map<FieldKey, string>();
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const matched = FIELD_LINE.exec(line);
		const key = matched?.[1]?.toLowerCase() ?? "";
		if (matched === null || !isFieldKey(key)) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} is not a "<field>: <value>" line over ${KEYS.join(", ")}: "${line}"`,
			};
		}
		if (seen.has(key)) {
			return {
				_tag: "Unusable",
				reason: `"${key}" is given twice — which one is the field is undecidable`,
			};
		}
		seen.set(key, matched[2] ?? "");
	}

	const missing = KEYS.filter((key) => (seen.get(key) ?? "").trim() === "");
	if (missing.length > 0) {
		return {
			_tag: "Unusable",
			reason: `no value for ${missing.join(", ")} — every field is required`,
		};
	}

	const namespace = (seen.get("namespace") ?? "").trim().toLowerCase();
	if (!NAMESPACE.test(namespace)) {
		return {
			_tag: "Unusable",
			reason: `"${namespace}" is not a "review", "review-<gate>", "check-epic-plan" or "governance" namespace`,
		};
	}
	const polarity = polarityOf((seen.get("polarity") ?? "").trim());
	if (polarity === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("polarity")}" is not a polarity — expected PASS or FAIL`,
		};
	}
	const sha = headSha(seen.get("sha") ?? "");
	if (sha === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("sha")}" is not a head SHA — expected ${SHA_MIN}–${SHA_MAX} hex characters`,
		};
	}
	const text = clause(seen.get("clause") ?? "");
	if (text === null) {
		return {_tag: "Unusable", reason: "the trailing clause is blank"};
	}
	return {_tag: "Fields", marker: {namespace, polarity, sha, clause: text}};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderMarker = (marker: VerdictMarker): NonEmptyReadonlyArray<string> => [
	`namespace\t${marker.namespace}`,
	`polarity\t${marker.polarity}`,
	`sha\t${marker.sha}`,
	`clause\t${marker.clause}`,
];

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.marker)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderMarker(result.value)} : result;
};
