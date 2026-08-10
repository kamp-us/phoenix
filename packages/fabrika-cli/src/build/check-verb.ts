/**
 * `build check` — this surface's validators, run in this tree, with the build cache **bypassed**.
 *
 * The bypass is the design, not an option. A cache hit from another worktree returned another tree's
 * green three times in one session (#4106) and recurred on the review side (#4887); re-running is
 * cheaper than trusting a key that has already lied. And the command set is the verb's, not the
 * agent's memory: v1 mandated the exact CI commands in prose with nothing enforcing it
 * (`SKILL.md:895-935`).
 *
 * **This verb predicts; the gate decides.** `ci.yml` owns redness, and where the two disagree the
 * gate's answer supersedes this one (interface convention rule 6). Nothing here re-reads CI.
 *
 * `--surface` is an **anchor, not a second classifier**: naming the surface is a judgement the skill
 * makes reading the issue, and a verb that guessed it from file extensions would be wrong exactly on
 * the mixed diffs where the answer matters. The verb takes the skill's answer and refuses one the diff
 * provably contradicts.
 *
 * **Green means "the validators ran and passed", never "I could not tell."** See {@link classifyDiff}
 * for the third file class that keeps that distinction representable (#5229), and
 * {@link notCoveredBy} for the per-surface coverage the green's `unvalidated` list reports (#5288).
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireSession} from "./claim.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNCLASSIFIED_DIFF,
	VALIDATION_RED,
	ZERO_SCOPE,
} from "./codes.ts";
import {predecessorsOf, readTopology, renderRef, sameRef} from "./dependencies.ts";
import {changedFiles, mergeBase} from "./git.ts";
import {defaultBranch} from "./github.ts";
import {requireLane} from "./lane-guard.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build check";

export const SURFACES = ["code", "prose", "plan"] as const;
export type Surface = (typeof SURFACES)[number];

const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
const MARKDOWN_RE = /\.mdx?$/;

/** The exact CI commands, cache-bypassed. `--force` is turbo's; `lint:worktree` has no cache to hit. */
const CODE_RUNNERS: ReadonlyArray<{readonly label: string; readonly argv: ReadonlyArray<string>}> =
	[
		{label: "pnpm typecheck --force", argv: ["typecheck", "--force"]},
		{label: "pnpm lint:worktree", argv: ["lint:worktree"]},
	];

export interface CheckOptions {
	readonly surface: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The changed files split three ways, with `unvalidatable` the file class **no** surface validates.
 *
 * That third bucket is the point. Filtering with the two regexes and reading nothing off what fell
 * out of both made "matched neither" an absence, and an absence cannot be refused: a `.yml`/`.sh`
 * diff produced an empty markdown list, zero validator iterations and a green that had opened no
 * file (#5229). Named, it is a state the verb can act on.
 *
 * `unvalidatable` is a property of the **tree** — no surface covers these files. Whether *this* run
 * covered a file is a narrower question, and {@link notCoveredBy} is the one that answers it; the two
 * were the same word once, which is how a markdown file could sit outside a `--surface code` green's
 * disclosure while the field's own documentation said it listed everything the verdict missed (#5288).
 */
export interface DiffClasses {
	readonly code: ReadonlyArray<string>;
	readonly markdown: ReadonlyArray<string>;
	readonly unvalidatable: ReadonlyArray<string>;
}

export const classifyDiff = (files: ReadonlyArray<string>): DiffClasses => ({
	code: files.filter((f) => CODE_RE.test(f)),
	markdown: files.filter((f) => MARKDOWN_RE.test(f)),
	unvalidatable: files.filter((f) => !CODE_RE.test(f) && !MARKDOWN_RE.test(f)),
});

/** The file classes each surface's validators actually open. `unvalidatable` is in no surface's. */
const COVERS: Record<Surface, ReadonlyArray<keyof DiffClasses>> = {
	code: ["code"],
	prose: ["markdown"],
	plan: ["markdown"],
};

/**
 * The changed files this surface's validators do not read — what a green must disclose.
 *
 * A superset of the `unvalidatable` bucket, and the extra members are the whole point: `--surface
 * code` ran typecheck and `lint:worktree` over a `["a.ts", "README.md"]` diff, neither of which reads
 * markdown (`lint:worktree` filters `.md` out by extension), and greened with an empty disclosure —
 * which affirmatively reads as "nothing uncovered". `--surface plan` did the same to code files.
 * Reporting coverage per surface answers both with one rule instead of two (#5288).
 *
 * Disclosing is deliberately not validating: running the markdown validators under `--surface code`
 * would make the surface guess at file classes, which the anchor exists to refuse.
 */
export const notCoveredBy = (
	surface: Surface,
	files: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const classes = classifyDiff(files);
	const covered = new Set(COVERS[surface].flatMap((bucket) => classes[bucket]));
	return files.filter((file) => !covered.has(file));
};

/**
 * Why no surface can validate this diff at all, or `null`.
 *
 * Checked **before** {@link surfaceMismatch}, so a wholly-unvalidatable diff refuses with the honest
 * reason under every surface — including `code`, whose old "the diff changes no code file" was a true
 * sentence pointing at the wrong remedy (it invites `--surface prose`, the branch that greened).
 */
export const unvalidatableDiff = (files: ReadonlyArray<string>): string | null => {
	const {code, markdown, unvalidatable} = classifyDiff(files);
	if (code.length > 0 || markdown.length > 0) return null;
	const shown = unvalidatable.slice(0, 5).join(", ");
	const rest = unvalidatable.length > 5 ? `, +${unvalidatable.length - 5} more` : "";
	return `no surface validates any of the ${unvalidatable.length} changed file(s) (${shown}${rest})`;
};

/** Why `--surface` provably contradicts the diff, or `null`. */
export const surfaceMismatch = (surface: Surface, files: ReadonlyArray<string>): string | null => {
	const {code, markdown} = classifyDiff(files);
	if (surface === "prose" && code.length > 0) {
		return `--surface prose, but the diff is ${code.length} ${code.length === 1 ? "code file" : "code files"}`;
	}
	if (surface === "code" && code.length === 0) {
		return "--surface code, but the diff changes no code file";
	}
	if (surface === "plan" && markdown.length === 0) {
		return "--surface plan, but the diff changes no markdown file";
	}
	return null;
};

/** The machine-local paths a prose file carries, as defect lines. */
const leakDefects = (file: string, text: string): ReadonlyArray<string> =>
	scanBody(text).leaks.map(
		(leak) => `${file}:${leak.line} carries a machine-local path (${leak.class}): ${leak.text}`,
	);

/**
 * Every in-repo link target a markdown file names.
 *
 * Absolute URLs and bare fragments are skipped: a link with a scheme is not this tree's to resolve,
 * and a fragment resolves within the page. A fabrika doc cited by a relative path is covered by the
 * same rule, so there is no second reference check to drift from this one.
 */
/** Fold `.` and `..` out of an absolute path, so a link's target is compared in one spelling. */
export const normalizePath = (path: string): string => {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return `/${out.join("/")}`;
};

export const linkTargets = (text: string): ReadonlyArray<string> => {
	const targets: string[] = [];
	for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
		const target = (match[1] ?? "").split("#")[0]?.trim() ?? "";
		if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		targets.push(target);
	}
	return targets;
};

const planDefects = (file: string, text: string): ReadonlyArray<string> => {
	const topology = readTopology(text);
	if (topology._tag === "Absent") return [];
	if (topology._tag === "Unparseable") {
		return [
			`${file}:${topology.line} does not parse under the "## Dependencies" grammar: "${topology.text}"`,
		];
	}
	const defects: string[] = [];
	const declared = topology.edges.flatMap((edge) =>
		edge._tag === "Phase" ? edge.members : [edge.subject, ...edge.needs],
	);
	for (const edge of topology.edges) {
		if (edge._tag !== "Requires") continue;
		if (edge.needs.some((need) => sameRef(need, edge.subject))) {
			defects.push(`${file}: ${renderRef(edge.subject)} requires itself`);
		}
	}
	for (const ref of declared) {
		if (ref._tag !== "Local") continue;
		const named = topology.edges.some(
			(edge) => edge._tag === "Phase" && edge.members.some((member) => sameRef(member, ref)),
		);
		if (!named) defects.push(`${file}: ${renderRef(ref)} is not named by any phase line`);
	}
	for (const ref of declared) {
		if (ref._tag !== "Issue") continue;
		const cycle = predecessorsOf(topology.edges, ref).some(({ref: predecessor}) =>
			sameRef(predecessor, ref),
		);
		if (cycle) defects.push(`${file}: #${ref.number} is its own predecessor`);
	}
	return defects;
};

export const runCheck = (
	options: CheckOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const surface = options.surface.trim().toLowerCase();
		if (!(SURFACES as ReadonlyArray<string>).includes(surface)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --surface "${options.surface}" is off the closed vocabulary (${SURFACES.join(" | ")}).`,
			);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const lane = yield* requireLane(VERB, resolved.repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;

		const branch = yield* defaultBranch(resolved.repo);
		if (branch._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${resolved.repo}'s default branch: ${branch.reason} — the diff base is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const base = `origin/${branch.value}`;
		const merged = yield* mergeBase(base);
		if (merged._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the merge base with ${base}: ${merged.reason} — the verdict is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const listed = yield* changedFiles(merged.value);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff against ${base}: ${listed.reason} — the verdict is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const files = listed.value;
		const scope = [...lane.notes, `${VERB}: ${files.length} changed file(s) against ${base}.`];
		if (files.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the diff against ${base} is empty — nothing to validate (ADR 0092).`,
				scope,
			);
		}
		const unvalidatable = unvalidatableDiff(files);
		if (unvalidatable !== null) {
			return refuse(
				UNCLASSIFIED_DIFF,
				`${VERB}: ${unvalidatable} — there is nothing here to run, so the verdict is a refusal, never green.`,
				scope,
			);
		}
		const mismatch = surfaceMismatch(surface as Surface, files);
		if (mismatch !== null) {
			return refuse(OFF_VOCABULARY, `${VERB}: ${mismatch} — the surface is provably wrong.`, scope);
		}
		const {markdown} = classifyDiff(files);
		// A partial green has to carry what it skipped, on both channels: #5187 greened over 25 workflow
		// files whose `ran` line was true and misleading at once (#5229), and a `--surface code` green
		// then did the same to markdown while reporting an empty list (#5288).
		const unvalidated = notCoveredBy(surface as Surface, files);
		const noted =
			unvalidated.length === 0
				? scope
				: [
						...scope,
						`${VERB}: ${unvalidated.length} changed file(s) --surface ${surface} does not validate — NOT covered by this verdict: ${unvalidated.join(", ")}.`,
					];

		if (surface === "code") {
			const ran: string[] = [];
			for (const runner of CODE_RUNNERS) {
				const result = yield* execCapture("pnpm", runner.argv);
				ran.push(runner.label);
				if (!result.ok) {
					return refuse(
						VALIDATION_RED,
						`${VERB}: red — ${runner.label} failed; diagnostics above.`,
						[...noted, result.reason],
					);
				}
			}
			return answer(
				JSON.stringify({verdict: "green", surface, tree: lane.root, ran, unvalidated}),
				noted,
			);
		}

		const fs = yield* FileSystem.FileSystem;
		const defects: string[] = [];
		for (const file of markdown) {
			const path = `${lane.root}/${file}`;
			const text = yield* fs.readFileString(path).pipe(
				Effect.map((t) => ({ok: true, t}) as {ok: boolean; t: string}),
				Effect.catchTag("PlatformError", () => Effect.succeed({ok: false, t: ""})),
			);
			if (!text.ok) continue; // a deleted file has nothing to validate; the diff still counted it.
			if (surface !== "prose") {
				defects.push(...planDefects(file, text.t));
				continue;
			}
			defects.push(...leakDefects(file, text.t));
			const dir = path.slice(0, path.lastIndexOf("/"));
			for (const target of linkTargets(text.t)) {
				const absolute = normalizePath(
					target.startsWith("/") ? `${lane.root}${target}` : `${dir}/${target}`,
				);
				const there = yield* fs
					.exists(absolute)
					.pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
				if (!there) defects.push(`${file} links to "${target}", which does not resolve`);
			}
		}
		if (defects.length > 0) {
			return refuse(
				VALIDATION_RED,
				`${VERB}: red — the ${surface} validators failed; diagnostics above.`,
				[...noted, ...defects],
			);
		}
		return answer(
			JSON.stringify({
				verdict: "green",
				surface,
				tree: lane.root,
				ran: [surface === "prose" ? "markdown link + leak scan" : "## Dependencies grammar"],
				unvalidated,
			}),
			noted,
		);
	});
