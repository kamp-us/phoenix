/**
 * `build pr` — open the PR from a stdin body, refusing the known defect shapes, with a read-back.
 *
 * *Authoring* stays the skill's; the guards here are mechanical and run **in order, all before any
 * write**: stdin non-empty (`3`), no machine-local path (`5` / `6`), body shape (`4`), no
 * classification claim (`10`), then the claim and the target issue (`15` / `11` / `7`). The ordering
 * is the point — a body that would be refused should be refused before a PR exists to carry it.
 *
 * An already-open PR for this head branch is an **answer**, not an error: a create whose outcome could
 * not be proven (`8`) is re-run, and the re-run must not open a second PR (#4544's class).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullRequest} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {requireSession} from "./claim.ts";
import {
	BAD_SECTIONS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {createPull, defaultBranch, openPullForHead} from "./github.ts";
import {requireLane} from "./lane-guard.ts";
import {bodyDefect, classificationIn, proseOf} from "./pr-body.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

const VERB = "build pr";

const SURFACE = {
	verb: VERB,
	emptyMessage: `${VERB}: stdin held nothing — the body is the input.`,
	bareAtMessage: `${VERB}: the body is a bare @ path reference — write the body, not a pointer to it.`,
};

export interface PrOptions {
	readonly number: number;
	/** The acceptance criteria are not all met: the body must say `Part of #<n>`, not `Fixes #<n>`. */
	readonly partial: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** The `4` refusal for each shape defect, in the contract's own words. */
const shapeRefusal = (
	defect: NonNullable<ReturnType<typeof bodyDefect>>,
	issue: number,
	partial: boolean,
): VerbOutcome => {
	switch (defect._tag) {
		case "NoDeviations":
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the body's "## Deviations" section is not readable — ${defect.reason}. State each deviation as an entry, or state "None."`,
			);
		case "StrayClosing":
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the body carries a closing keyword aimed at #${defect.target} — this PR serves #${issue}.`,
			);
		case "ClosesWhilePartial":
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the body says "Fixes #${defect.target}" but --partial was given — a partial PR must say "Part of #${defect.target}".`,
			);
		case "DuplicateClosing":
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the body carries more than one closing keyword aimed at #${issue} — exactly one closes the issue.`,
			);
		case "NoLink":
			return refuse(
				BAD_SECTIONS,
				partial
					? `${VERB}: the body names no "Part of #${issue}" line — a partial PR must say what it is part of.`
					: `${VERB}: the body names no "Fixes #${issue}" line — a PR that closes its issue must say so.`,
			);
	}
};

export const runPr = (
	options: PrOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number, partial} = options;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const body = authored.text;

		const leaked = leakRefusal(VERB, body);
		if (leaked !== null) return leaked;

		const defect = bodyDefect(body, number, partial);
		if (defect !== null) return shapeRefusal(defect, number, partial);

		const classification = classificationIn(proseOf(body));
		if (classification !== null) {
			return refuse(
				OFF_VOCABULARY,
				classification === "control-plane"
					? `${VERB}: the body asserts a control-plane classification — that verdict is the merge gate's.`
					: `${VERB}: the body asserts a ${classification} classification — that verdict is triage's.`,
			);
		}

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openIssue(
			VERB,
			repo,
			number,
			(reason) => `${VERB}: cannot read #${number}: ${reason} — nothing was written.`,
		);
		if (target._tag === "Refused") return target.outcome;

		const lane = yield* requireLane(VERB, repo, session.id, number);
		if (lane._tag === "Refused") return lane.outcome;

		const existing = yield* openPullForHead(repo, lane.branch);
		if (existing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the open pull requests for ${lane.branch}: ${existing.reason} — nothing was written.`,
				lane.notes,
			);
		}
		if (existing.value !== null) {
			return answer(
				JSON.stringify({
					answer: "existing",
					number: existing.value.number,
					url: existing.value.url,
				}),
				lane.notes,
			);
		}

		const base = yield* defaultBranch(repo);
		if (base._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s default branch: ${base.reason} — nothing was written.`,
				lane.notes,
			);
		}

		const created = yield* createPull(repo, target.issue.title, lane.branch, base.value, body);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the create failed: ${created.reason} — it may or may not have landed; re-run, the verb re-checks for an existing PR first.`,
				lane.notes,
			);
		}

		const back = yield* getPullRequest(repo, created.value.number);
		const matches =
			back._tag === "Present" &&
			normalizeForReadback(back.value.body) === normalizeForReadback(body);
		return matches
			? answer(
					JSON.stringify({answer: "opened", number: created.value.number, url: created.value.url}),
					lane.notes,
				)
			: refuse(
					READBACK_MISMATCH,
					`${VERB}: the PR landed (#${created.value.number}) but its body does not read back as sent — it needs a human eye.`,
					lane.notes,
				);
	});
