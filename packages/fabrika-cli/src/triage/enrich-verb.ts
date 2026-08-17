/**
 * `triage enrich` — write a rewrite (or, with `--epic`, a pitch) above the preserved original.
 *
 * This is the group's only body-writing verb, so it is the only one that can destroy a filing. Two
 * decisions carry that weight, and both live in `./enrich.ts`: a prior enrichment is recognised by
 * the **marker the verb itself wrote**, and the marker is also the boundary between the region this
 * verb owns and the bytes it must never touch.
 *
 * **The leak asymmetry is the reason the guard runs over stdin rather than the composed body.**
 * `readAuthored`'s callers usually scan what they composed, so nothing a verb appends can escape the
 * predicate. Here the composed body *contains foreign content by design* — the preserved original —
 * and that content is redacted, not refused, because refusing it would strand the enrichment on
 * somebody else's leak while preserving it unredacted would re-commit that leak to a public issue.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, patchIssueBody, resolveRepo} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {
	MALFORMED_CRITERIA,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {authoredRegion, composeBody, detect, type EnrichMode, wrapOriginal} from "./enrich.ts";
import {legacyPreserved} from "./enrich-legacy.ts";

export interface EnrichOptions {
	readonly issue: number;
	/** `--epic`: stdin carries the pitch, and the original is wrapped under a fixed header. */
	readonly epic: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runEnrich = (
	options: EnrichOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;
		const mode: EnrichMode = options.epic ? "wrap" : "rewrite";
		const surface = {
			verb: "triage enrich",
			noun: options.epic ? "the pitch" : "the rewrite",
			emptyHint: options.epic
				? "pipe the pitch's five field lines in."
				: "pipe the rewritten body in.",
		};

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `triage enrich: ${issue} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"triage enrich: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const authored = readAuthored(surface, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const leak = leakRefusal(surface, authored.text);
		if (leak !== null) return leak;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `triage enrich: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage enrich: cannot read #${issue} in ${repo}: ${target.reason} — refusing to write an envelope over an original that was never read.`,
			);
		}

		const before = target.value.body;
		const detection = detect(before, issue, legacyPreserved);

		// A first enrichment redacts the original it is about to bury; a re-enrichment preserves bytes
		// that were already redacted when they were buried, so re-scanning them would only re-report a
		// count nobody can act on.
		let preserved: string;
		let redactions: number;
		const diagnostics: string[] = [];

		if (detection._tag === "Enriched") {
			preserved = detection.preserved;
			redactions = 0;
			diagnostics.push(
				detection.via === "marker"
					? `triage enrich: #${issue} carries this issue's enrichment marker (mode=${detection.markedMode}) — replacing the authored region and preserving ${preserved.length} byte(s) below it.`
					: `triage enrich: #${issue} carries a pre-marker v1 envelope — preserving it, stamping the marker in passing, and never wrapping it a second time.`,
			);
		} else {
			if (before.trim() === "") {
				return refuse(
					ZERO_SCOPE,
					`triage enrich: #${issue} has an empty body — there is no original to preserve, and an empty one must never be preserved as though it were the record.`,
				);
			}
			const scan = scanBody(before);
			preserved = wrapOriginal(mode, scan.redacted);
			redactions = scan.leaks.length;
			diagnostics.push(
				detection.reason === "marker binds another issue"
					? `triage enrich: #${issue} carries an enrichment marker bound to #${detection.boundTo}, not #${issue} — reading it as a pasted body and wrapping it as a first enrichment.`
					: `triage enrich: #${issue} carries no enrichment marker — wrapping its body as a first enrichment.`,
			);
			if (redactions > 0) {
				diagnostics.push(
					`triage enrich: redacted ${redactions} machine-local path(s) from the preserved original (lines ${scan.leaks
						.map((hit) => hit.line)
						.join(", ")}).`,
					...renderLeaks(scan.leaks),
				);
			}
		}

		const composed = composeBody({mode, issue, authored: authored.text, preserved});

		// ADR 0288 §1: the read runs over the bytes about to be posted, not over stdin — an enclosing
		// template can demote a heading that arrived conforming. It is scoped to the region above the
		// marker, which `composeBody` guarantees is `composed`'s own prefix, because the preserved
		// original below it is redacted rather than refused; a legacy `##` heading buried there would
		// otherwise refuse every re-enrichment forever. `Absent` stays allowed (#5565).
		const criteria = readCriteria(authoredRegion(mode, authored.text));
		if (criteria._tag === "Malformed") {
			return refuse(
				MALFORMED_CRITERIA,
				`triage enrich: ${surface.noun} composes an acceptance-criteria block the wire reader rejects — ${criteria.reason} (${criteria.evidence}). The grammar is owned by packages/fabrika-cli/src/wire/acceptance-criteria.ts; fix the block or drop it.`,
			);
		}

		const written = yield* patchIssueBody(repo, issue, composed);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`triage enrich: PATCH failed: ${written.reason} — UNKNOWN whether the body changed; re-read #${issue} before retrying.`,
				diagnostics,
			);
		}

		const back = yield* getIssue(repo, issue);
		if (back._tag !== "Present") {
			return refuse(
				READBACK_MISMATCH,
				`triage enrich: body written but it could not be read back (${
					back._tag === "Absent" ? "the issue is now absent" : back.reason
				}) — inspect #${issue} before continuing.`,
				diagnostics,
			);
		}
		if (normalizeForReadback(back.value.body) !== normalizeForReadback(composed)) {
			return refuse(
				READBACK_MISMATCH,
				`triage enrich: body written but the read-back does not match — inspect #${issue} before continuing.`,
				diagnostics,
			);
		}

		return json
			? answer(JSON.stringify({outcome: "enriched", number: issue, redactions, mode}), diagnostics)
			: answer(`enriched\t${issue}\t${redactions}`, diagnostics);
	});
