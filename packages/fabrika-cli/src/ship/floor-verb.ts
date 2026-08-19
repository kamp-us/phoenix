/**
 * `ship floor` — the governance floor as an exit code, so a CI job can red on it.
 *
 * `ship gate` seats `blocked` at exit 0, and that is right for its interface: `blocked` is an answer
 * it proved, and a produced answer goes on 0 (`../verb.ts`). But an answer nobody reads enforces
 * nothing. The floor landed in #5231 and two fabrika-tree PRs merged with no governance verdict
 * anyway, because the only thing turning `blocked` into a stop was prose in the `ship` skill (#5408).
 * A workflow step cannot read `gate\tblocked` on its own without deciding in bash, which ADR 0228
 * forbids — so the decision is seated here and CI relays this verb's exit code.
 *
 * **One namespace, and the resolution is `runGate`'s own.** This verb is not a second conjunction: it
 * asks `ship gate` for `governance` and reads that one line back, so there is one derivation of an
 * in-force verdict in this package and no rival answer about any other namespace. It decides nothing
 * about enqueue either — `ship gate` stays the single merge authority.
 *
 * **It refuses on WRONG, not only on MISSING.** `absent`, `stale` and `fail` all seat
 * {@link GOVERNANCE_FLOOR_UNMET}; a verdict from an author without write+ resolves `absent` through
 * the ADR 0055 ACL gate and lands there too. Only a head-bound PASS from an authorized author is
 * satisfied.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {listPullFiles} from "../io/pulls.ts";
import {touchesGovernanceRoot} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	GOVERNANCE_FLOOR_UNMET,
	INCOMPLETE_SCAN,
	PRECONDITION_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runGate} from "./gate-verb.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship floor";

const NAMESPACE = "governance";

export interface FloorOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** What each blocking state means for the person reading a red check, and what clears it. */
const REMEDY: Readonly<Record<string, string>> = {
	absent:
		"no authorized governance verdict at this head — run the `governance` skill and emit one with `fabrika governance post`",
	stale:
		"the in-force governance verdict is bound to another head — re-judge at this head and re-post (ADR 0058)",
	fail: "the in-force governance verdict at this head is FAIL — repair the diff and re-post",
};

/**
 * The one `ns` row this verb reads out of `ship gate --json`.
 *
 * Validated rather than cast: a payload that does not carry the row is UNKNOWN, and reading a missing
 * row as anything at all is the shape that would let a parse change turn the floor off silently.
 */
const governanceState = (stdout: string): string | null => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed)) return null;
	const namespaces = parsed.namespaces;
	if (!Array.isArray(namespaces)) return null;
	for (const row of namespaces) {
		if (!isRecord(row)) continue;
		if (row.name === NAMESPACE && typeof row.state === "string") return row.state;
	}
	return null;
};

export const runFloor = (
	options: FloorOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			'whether the floor binds is UNKNOWN, never "n/a".',
		);
		if (governed._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, governed.message);

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to gate.",
			unknownMessage: (reason) =>
				`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — whether the floor binds is UNKNOWN, never "n/a".`,
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the changed-file list for #${pr}: ${listed.reason} — whether the floor binds is UNKNOWN, never "n/a".`,
			);
		}
		const scanned = [
			scannedLine(VERB, listed.value.length, "changed file", `${pull.changedFiles} declared`),
		];
		if (listed.value.length < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${listed.value.length} of ${pull.changedFiles} changed files — a governance root could sit in the part nobody read.`,
				scanned,
			);
		}
		if (listed.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} has zero changed files — whether it touches a governance root is unanswerable (ADR 0092).`,
				scanned,
			);
		}

		if (!touchesGovernanceRoot(listed.value, governed.roots)) {
			const clear = `${VERB}: #${pr}'s diff touches no governance root, so the floor does not bind — this is an answer about the diff, not a discharged verdict.`;
			return answer(
				json
					? JSON.stringify({
							outcome: "n/a",
							sha: bound,
							namespace: NAMESPACE,
							state: null,
							scanned: listed.value.length,
						})
					: `floor\tn/a\t${bound}\nns\t${NAMESPACE}\t${NULL_TOKEN}`,
				[...scanned, clear],
			);
		}

		// The floor's whole resolution — marker read, ADR 0055 ACL, head-binding, in-force ordering —
		// is `ship gate`'s, asked for this one namespace. A second file read cannot loosen the
		// requirement: `--require governance` is passed because the read above already proved a
		// governance root, so a diff that changed under us still gates.
		const gated = yield* runGate({
			pr,
			sha: bound,
			require: [NAMESPACE],
			cp: false,
			repo,
			json: true,
			cwd: options.cwd,
			env: options.env,
		});
		const relayed = [...scanned, ...gated.stderr];
		if (gated.code !== 0) {
			return {...gated, stderr: relayed};
		}

		const state = governanceState(gated.stdout);
		if (state === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: \`ship gate\` answered without a resolvable ${NAMESPACE} row — the floor is UNKNOWN, never discharged.`,
				relayed,
			);
		}
		if (state !== "pass") {
			return refuse(
				GOVERNANCE_FLOOR_UNMET,
				`${VERB}: #${pr} touches a governance root and its ${NAMESPACE} verdict at ${bound} is ${state} — ${REMEDY[state] ?? "the floor is not discharged"} (#5408).`,
				relayed,
			);
		}
		return answer(
			json
				? JSON.stringify({
						outcome: "satisfied",
						sha: bound,
						namespace: NAMESPACE,
						state,
						scanned: listed.value.length,
					})
				: `floor\tsatisfied\t${bound}\nns\t${NAMESPACE}\t${state}`,
			relayed,
		);
	});
