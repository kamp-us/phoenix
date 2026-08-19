/**
 * `guard roadmap-guard check` — the IO shell around `./roadmap.ts`.
 *
 * It reads two things and judges neither: `ROADMAP.md` off the repo root, and the milestone
 * projection off `gh api`. Every invariant lives in the pure core, so the only decisions here are
 * which failure is which — and that split is the port's whole point. The pipeline-cli original exited
 * `1` for drift, for an unreadable `ROADMAP.md` and for a `gh` that could not answer; those three
 * have opposite remedies, so here they are `12`, `11` and `11`, and a roadmap with no arcs or a repo
 * with no milestones is `7` rather than a green over nothing (ADR 0092).
 */

import {Effect, type FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import {SHIPPED_ROADMAP_FILE} from "../config/keys/paths.ts";
import {readRoadmapFile} from "../config/paths.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {type ReadFailed, readFile} from "../io/fs.ts";
import {listMilestones, resolveRepo} from "../io/issues.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {judge, parseRoadmap, renderReport, VERB} from "./roadmap.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

/**
 * The file this guard validates, as the shipped default.
 *
 * The repo names it in `.fabrika.jsonc`'s `roadmapFile`, resolved below. This constant is only the
 * fallback the two pre-root messages need, since a `cwd` in no repository has no config to read
 * either.
 */
const ROADMAP = SHIPPED_ROADMAP_FILE;

export interface RoadmapGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	/** An explicit `owner/name`, or `null` to resolve from the env and then the `origin` remote. */
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The drift verdict, with every finding annotated onto `ROADMAP.md`.
 *
 * All the annotations hang on the file rather than on a line: the offending row is named in each
 * message, but a milestone that drifted out from under a correct row has no line to point at.
 */
const drifted = (report: string, findings: ReadonlyArray<string>, roadmap: string): GuardVerdict =>
	violation(
		report,
		annotationsOrNone(() => findings.map((message) => atFile("error", roadmap, message))),
	);

export const runRoadmapGuard = (
	options: RoadmapGuardOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — there is no ${ROADMAP} to read, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}

		// The file the repo declares, not this guard's own literal: a guard validating `ROADMAP.md`
		// while the fence reads `PLAN.md` is one key with two answers (#4730's shape).
		const declared = yield* readRoadmapFile(options.cwd);
		if (declared._tag === "Refused") {
			return emitVerdict(
				unknown(
					`${VERB}: ${CONFIG_PATH} is refused — ${declared.reason.replace(/\.$/, "")}, so which file this guard validates is unread and the verdict is UNKNOWN, never clean.`,
				),
				options.env,
			);
		}
		const roadmap = declared.value;

		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return emitVerdict(
				unknown(
					`${VERB}: cannot resolve a target repo (${resolved.reason}) — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves. Without it the milestone projection is UNKNOWN.`,
				),
				options.env,
			);
		}

		const md = yield* readFile(path.join(root, roadmap));
		const listed = yield* listMilestones(resolved.value);
		if (listed._tag === "Failure") {
			return emitVerdict(
				unknown(
					`${VERB}: cannot read ${resolved.value}'s milestones: ${listed.reason} — ${roadmap} was parsed but has nothing to be validated against, so the verdict is UNKNOWN, never clean.`,
				),
				options.env,
			);
		}

		const {arcs, campaigns} = parseRoadmap(md);
		const verdict = judge(arcs, campaigns, listed.value);
		const report = renderReport(verdict);
		if (verdict.pass) {
			return emitVerdict(clean(report, verdict.arcCount + verdict.campaignCount), options.env);
		}
		return emitVerdict(
			verdict.reason === "zero-scope"
				? zeroScope(report)
				: drifted(
						report,
						verdict.violations.map((v) => `[${v.code}] ${v.message}`),
						roadmap,
					),
			options.env,
		);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure: ReadFailed) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — ${ROADMAP} is the sole parsed surface, so with it unread the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
