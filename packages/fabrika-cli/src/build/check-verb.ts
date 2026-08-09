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
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "../io/exec.ts";
import {scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireSession} from "./claim.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, VALIDATION_RED, ZERO_SCOPE} from "./codes.ts";
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

/** Why `--surface` provably contradicts the diff, or `null`. */
export const surfaceMismatch = (surface: Surface, files: ReadonlyArray<string>): string | null => {
	const code = files.filter((f) => CODE_RE.test(f));
	const markdown = files.filter((f) => MARKDOWN_RE.test(f));
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
		const mismatch = surfaceMismatch(surface as Surface, files);
		if (mismatch !== null) {
			return refuse(OFF_VOCABULARY, `${VERB}: ${mismatch} — the surface is provably wrong.`, scope);
		}

		if (surface === "code") {
			const ran: string[] = [];
			for (const runner of CODE_RUNNERS) {
				const result = yield* execCapture("pnpm", runner.argv);
				ran.push(runner.label);
				if (!result.ok) {
					return refuse(
						VALIDATION_RED,
						`${VERB}: red — ${runner.label} failed; diagnostics above.`,
						[...scope, result.reason],
					);
				}
			}
			return answer(JSON.stringify({verdict: "green", surface, tree: lane.root, ran}), scope);
		}

		const fs = yield* FileSystem.FileSystem;
		const markdown = files.filter((file) => MARKDOWN_RE.test(file));
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
				[...scope, ...defects],
			);
		}
		return answer(
			JSON.stringify({
				verdict: "green",
				surface,
				tree: lane.root,
				ran: [surface === "prose" ? "markdown link + leak scan" : "## Dependencies grammar"],
			}),
			scope,
		);
	});
