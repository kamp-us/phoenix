/**
 * `graduate emit` — file the one spec issue, apply the single label, read it back, and record the
 * emission on the source.
 *
 * **One transaction**, checked local-first so a refusable spec costs no API call.
 *
 * <!-- anchor: WRITE-ORDERING-IS-AN-INVARIANT --> **The spec issue is created first and the marker
 * second.** An interrupted run that wrote the marker first would leave a source claiming an emission
 * that does not exist — a trail that can never be graduated again and a spec nobody can find. The
 * reverse leaves a filed spec with no marker, which is `8` naming the orphan and which a human
 * resolves by reading the source. A missing marker is a nuisance; a marker with no issue is a
 * silently dropped spec.
 *
 * <!-- anchor: THE-BODY-MUST-MATCH-THE-TRAIL-IT-BINDS --> **The trail is re-derived here rather than
 * trusted from `--spec`.** Without that, a caller could compose against trail A and emit against a
 * source that has since moved to trail B, so the marker would bind a digest computed from B while the
 * filed body stated A's decisions. The body supplies only the ref *list*; the provenance and text the
 * digest is taken over come from the resolver, which is why a forged body cannot forge a digest.
 *
 * <!-- anchor: EIGHTEEN-IS-PER-REF-NOT-WHOLE-SECTION --> `18` compares ref by ref. A whole-section
 * equality check against the re-derived trail would fail every deliberately split spec, which would
 * reinstate the stranded remainder through a different code.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	createComment,
	createIssue,
	type Existence,
	getIssue,
	type IssueRecord,
	listComments,
	listLabels,
	resolveRepo,
} from "../io/issues.ts";
import {classifyingPrefix, deriveVocabulary, normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import * as graduateEmitted from "../wire/graduate-emitted.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {
	ALREADY_GRADUATED,
	BAD_SECTIONS,
	BARE_AT_PATH,
	CLASSIFIED,
	DECISIONS_STALE,
	DIGEST_UNBINDABLE,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TRAIL_BLOCKED,
	TRAIL_EMPTY,
	WRITE_UNKNOWN,
} from "./codes.ts";
import type {DocumentRead} from "./compose-verb.ts";
import {scanEmissions} from "./read-verb.ts";
import {deriveTrail, requireSource} from "./source.ts";
import {
	checkSections,
	readDecisionsSection,
	renderFooter,
	SPEC_SECTIONS,
	withFooter,
} from "./spec.ts";
import {digestOfDecisions} from "./trail.ts";

/** Unreachable: the digest is built here and the covered set is non-empty by the checks above. */
const never = (what: string): never => {
	throw new Error(`graduate emit: ${what} did not build — the verb's own invariant broke`);
};

/** The one label a spec leaves carrying, and the only one this verb may apply. */
export const INTAKE_LABEL = "status:needs-triage";

export interface EmitOptions<R = never> {
	readonly source: number;
	readonly specPath: string;
	readonly spec: Effect.Effect<DocumentRead, never, R>;
	readonly title: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The footer's timestamp, injected so a filing is byte-reproducible in a test. */
	readonly now: () => Date;
}

const VERB = "graduate emit";

/**
 * What the read-back found wrong, or `null`.
 *
 * Four assertions, none inherited: `report file`'s helper re-asserts its own six intake headings and
 * its own `Filed by an agent` footer marker, so importing it would refuse every spec this group files
 * twice over.
 */
export const readbackMismatch = (
	landed: Existence<IssueRecord>,
	title: string,
	composed: string,
): string | null => {
	if (landed._tag === "Absent") return "the issue is not readable after the create";
	if (landed._tag === "Unknown") return `the read-back itself failed: ${landed.reason}`;
	const issue = landed.value;
	if (issue.labels.length !== 1 || issue.labels[0] !== INTAKE_LABEL) {
		return `it carries labels [${issue.labels.join(", ")}] rather than exactly "${INTAKE_LABEL}"`;
	}
	if (issue.title !== title) return `its title is "${issue.title}" rather than what --title gave`;
	const missing = SPEC_SECTIONS.find((heading) => !issue.body.includes(heading));
	if (missing !== undefined) return `the body is missing section "${missing}"`;
	if (!/^<sub>Filed by an agent · graduated from #\d+ · spec [0-9a-f]{12} · /m.test(issue.body)) {
		return "the body does not end with this group's footer line";
	}
	return normalizeForReadback(issue.body) === normalizeForReadback(composed)
		? null
		: "the landed body differs from what was sent";
};

export const runEmit = <R = never>(
	options: EmitOptions<R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {source, title} = options;
		if (!Number.isInteger(source) || source <= 0) {
			return refuse(FAILED, `${VERB}: ${source} is not an issue number.`);
		}
		if (title.trim() === "") {
			return refuse(FAILED, `${VERB}: --title is empty — refusing to file an untitled spec.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		const document = yield* options.spec;
		if (document._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read --spec ${options.specPath}: ${document.reason} — nothing was filed.`,
			);
		}
		const body = document.text;

		const problem = checkSections(body, SPEC_SECTIONS);
		if (problem !== null) {
			return refuse(
				BAD_SECTIONS,
				problem._tag === "Missing"
					? `${VERB}: --spec ${options.specPath} is missing section "${problem.heading}".`
					: problem._tag === "Empty"
						? `${VERB}: --spec ${options.specPath} has an empty section "${problem.heading}".`
						: `${VERB}: --spec ${options.specPath} has sections out of order — "${problem.heading}" follows "${problem.after}".`,
			);
		}

		const stated = readDecisionsSection(body);
		if (stated._tag === "Unparseable") {
			return refuse(
				DECISIONS_STALE,
				`${VERB}: --spec ${options.specPath} has a ## Decisions line that does not parse: ${stated.line}. That section is machine-rendered, so a line this shape means the body was hand-edited.`,
			);
		}

		if (isBareAtReference(body) || isBareAtReference(title)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the spec is a bare @ path reference — not redactable, refusing to file it.`,
			);
		}
		const titleScan = scanBody(title);
		if (titleScan.leaks.length > 0) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: --title carries a machine-local path — refusing to file it.`,
				renderLeaks(titleScan.leaks),
			);
		}

		const found = yield* requireSource(VERB, repo, source);
		if (found._tag === "Refused") return found.outcome;

		const resolved = yield* deriveTrail(VERB, repo, source, found.value.kind, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {trail, scope} = resolved.value;

		if (trail.readiness === "blocked") {
			return refuse(
				TRAIL_BLOCKED,
				`${VERB}: #${source}'s trail reports readiness "blocked" — ${trail.unresolved.length} decision(s) unresolved: ${trail.unresolved.map((row) => row.ref).join(", ")}. Nothing was filed.`,
				[scope],
			);
		}
		if (trail.decisions.length === 0) {
			return refuse(
				TRAIL_EMPTY,
				`${VERB}: #${source}'s trail holds zero decisions — there is nothing to file.`,
				[scope],
			);
		}
		const unbindable = trail.decisions.find(
			(row) => row.ref.trim() === "" || row.text.trim() === "",
		);
		if (unbindable !== undefined) {
			return refuse(
				DIGEST_UNBINDABLE,
				`${VERB}: #${source}'s trail carries a decision with no ${unbindable.ref.trim() === "" ? "ref" : "text"} — it cannot be digested, so the emission binding is UNKNOWN. Nothing was filed.`,
				[scope],
			);
		}

		for (const claimed of stated.value) {
			const onTrail = trail.decisions.find((row) => row.ref === claimed.ref);
			if (onTrail === undefined) {
				return refuse(
					DECISIONS_STALE,
					`${VERB}: --spec ${options.specPath} carries ${claimed.ref}, which is no longer on #${source}'s trail — the source moved after the spec was composed. Re-run graduate trail and graduate compose.`,
					[scope],
				);
			}
			const drifted =
				onTrail.provenance !== claimed.provenance
					? "provenance"
					: onTrail.text !== claimed.text
						? "text"
						: null;
			if (drifted !== null) {
				return refuse(
					DECISIONS_STALE,
					`${VERB}: --spec ${options.specPath} carries ${claimed.ref}, whose ${drifted} on #${source} has changed since the spec was composed. Re-run graduate trail and graduate compose.`,
					[scope],
				);
			}
		}

		// The digest is taken over the RE-DERIVED entries, in trail order — the body names refs and
		// nothing more, which is what keeps a forged body from forging a digest.
		const covered = trail.decisions.filter((row) =>
			stated.value.some((claimed) => claimed.ref === row.ref),
		);
		const specDigest = digestOfDecisions(covered);

		const comments = yield* listComments(repo, source);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${source}: ${comments.reason} — whether this trail was already graduated is UNKNOWN. Nothing was filed.`,
				[scope],
			);
		}
		const already = scanEmissions(comments.value).emissions.find(
			(emission) => emission.specDigest === specDigest,
		);
		if (already !== undefined) {
			return refuse(
				ALREADY_GRADUATED,
				`${VERB}: #${source} already graduated this decision set into #${already.issue} at spec digest ${specDigest} — refusing to file the same spec twice. A DIFFERENT subset of the trail may still be graduated.`,
				[scope],
			);
		}

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the label set of ${repo}: ${labels.reason} — whether "${INTAKE_LABEL}" exists is UNKNOWN. Nothing was filed.`,
				[scope],
			);
		}
		if (!labels.value.includes(INTAKE_LABEL)) {
			return refuse(
				NO_TARGET,
				`${VERB}: label "${INTAKE_LABEL}" does not exist in ${repo} — refusing to file a spec no triage run can find. Create it, or run the front-door bootstrap (#4952).`,
				[scope],
			);
		}
		const prefix = classifyingPrefix(title, deriveVocabulary(labels.value));
		if (prefix !== null) {
			return refuse(
				CLASSIFIED,
				`${VERB}: --title classifies the work ("${prefix}") — type and priority are triage's (ADR 0246).`,
				[scope],
			);
		}

		const at = stampOf(options.now());
		if (at === null) {
			return refuse(
				FAILED,
				`${VERB}: the clock produced no ISO-8601 instant — the emission could not be stamped.`,
				[scope],
			);
		}
		// The footer is appended BEFORE the scan, never after: bytes added after a scan are bytes
		// nobody scanned, and this footer interpolates a source number and a digest (#3086).
		const composed = withFooter(body, renderFooter({source, specDigest, timestamp: at}));
		const scan = scanBody(composed);
		if (scan.leaks.length > 0) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the spec carries ${scan.leaks.length} machine-local path(s) — refusing to file them to a public issue.`,
				[scope, ...renderLeaks(scan.leaks)],
			);
		}

		const created = yield* createIssue(repo, title, composed, INTAKE_LABEL);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the create failed, so whether a spec issue exists is UNKNOWN — check ${repo} before re-running.`,
				[scope],
			);
		}

		const mismatch = readbackMismatch(yield* getIssue(repo, created.value.number), title, composed);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: filed #${created.value.number} but the read-back does not match what was sent: ${mismatch}.`,
				[scope],
			);
		}

		const [first, ...rest] = covered.map((row) => row.ref);
		const marker = yield* createComment(
			repo,
			source,
			graduateEmitted.emit({
				source,
				emitted: created.value.number,
				digest: graduateEmitted.specDigest(specDigest) ?? never(specDigest),
				covers: first === undefined ? never("a covered ref") : [first, ...rest],
				at,
			}),
		);
		if (marker._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: filed #${created.value.number} and the marker write failed — the spec EXISTS but #${source} does not record it, so a re-run would file a second. Post the marker or check #${source} before re-running.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				source,
				issue: created.value.number,
				url: created.value.url,
				specDigest,
				labels: [INTAKE_LABEL],
				marker: marker.value.id,
			}),
			[scope, `${VERB}: ${covered.length} decision(s) covered; spec digest ${specDigest}.`],
		);
	});
