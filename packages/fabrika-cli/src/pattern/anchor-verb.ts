/**
 * `pattern anchor` — whether the dependency version a doc declares still matches what the workspace
 * pins.
 *
 * A separate verb rather than a mode of `pattern drift` because the git half and the dependency half
 * go stale independently. **An unreadable manifest is UNKNOWN and never `unpinned`:** the two are one
 * keystroke apart in consequence — `unpinned` says the repo does not carry this dependency, and a
 * failed read says nothing at all. A manifest that is genuinely absent, or that carries no `catalog:`
 * key at all, is the degrade path instead: every declaration reports `unpinned` at exit `0` with the
 * absence named on stderr. A manifest that *does* carry a catalog this reader cannot comprehend is
 * UNKNOWN, never that degrade path — see `parseCatalog`.
 */
import {Effect, type FileSystem, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists} from "../io/fs.ts";
import {fetchAndResolve, readFileAt} from "../io/git.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	type AnchorOutcome,
	anchorOutcome,
	type Declaration,
	declarationLinesIn,
	parseCatalog,
	resolveDeclarations,
} from "./anchor.ts";
import {DOC_ABSENT, PRECONDITION_UNKNOWN} from "./codes.ts";
import {isKebabCase} from "./doc.ts";
import {pathPresentAt} from "./git.ts";

export interface AnchorOptions {
	readonly slug: string;
	readonly dir: string;
	readonly manifest: string;
	readonly base: string;
	readonly json: boolean;
}

const count = (declarations: ReadonlyArray<Declaration>, state: Declaration["state"]): number =>
	declarations.filter((d) => d.state === state).length;

const emit = (
	options: AnchorOptions,
	outcome: AnchorOutcome,
	declarations: ReadonlyArray<Declaration>,
	sha: string,
): string => {
	const moved = count(declarations, "moved");
	const unpinned = count(declarations, "unpinned");
	const malformed = count(declarations, "malformed");
	if (options.json) {
		return JSON.stringify({
			outcome,
			declared: declarations.length,
			moved,
			unpinned,
			malformed,
			packages: declarations.map((d) => ({
				package: d.package,
				declaredVersion: d.declaredVersion,
				pinnedVersion: d.pinnedVersion,
				state: d.state,
			})),
			manifest: options.manifest,
			baseRef: options.base,
			baseSha: sha,
		});
	}
	return [
		["anchor", outcome, declarations.length, moved, unpinned, malformed].join("\t"),
		...declarations.map((d) =>
			["pkg", d.package, d.declaredVersion ?? "-", d.pinnedVersion ?? "-", d.state].join("\t"),
		),
	].join("\n");
};

export const runAnchor = (
	options: AnchorOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const {slug, dir, manifest, base} = options;
		if (!isKebabCase(slug)) {
			return refuse(
				FAILED,
				`pattern anchor: slug "${slug}" is not kebab-case (lowercase letters, digits and single hyphens).`,
			);
		}

		const resolved = yield* fetchAndResolve(base);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern anchor: cannot fetch ${base}: ${resolved.reason} — the outcome is UNKNOWN, never "matched".`,
			);
		}
		const sha = resolved.value;
		const path = `${dir}/${slug}.md`;

		const atBase = yield* pathPresentAt(sha, path);
		if (atBase._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern anchor: cannot read ${path} at ${base}: ${atBase.reason} — the outcome is UNKNOWN, never "matched".`,
			);
		}

		if (!atBase.value) {
			const inTree = yield* Effect.result(exists(path));
			if (Result.isFailure(inTree)) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`pattern anchor: cannot read ${path}: ${inTree.failure.reason} — the outcome is UNKNOWN, never "matched".`,
				);
			}
			if (!inTree.success) {
				return refuse(
					DOC_ABSENT,
					`pattern anchor: no doc for slug "${slug}" under ${dir}, in the working tree or at ${base}.`,
				);
			}
			// `unborn` mirrors `pattern drift` deliberately: the skill runs the two back to back, so one
			// tree state must not produce two different verdicts.
			return answer(emit(options, "unborn", [], sha), [
				`pattern anchor: ${path} is in the working tree and absent at ${sha} — unborn, the same outcome pattern drift reports.`,
			]);
		}

		const text = yield* readFileAt(sha, path);
		if (text._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern anchor: cannot read ${path} at ${base}: ${text.reason} — the outcome is UNKNOWN, never "matched".`,
			);
		}

		const manifestPresent = yield* pathPresentAt(sha, manifest);
		if (manifestPresent._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`pattern anchor: cannot read ${manifest} at ${base}: ${manifestPresent.reason} — every pin is UNKNOWN, never "unpinned".`,
			);
		}

		let catalog: Readonly<Record<string, string>> | null = null;
		let degraded: string | null = null;
		if (!manifestPresent.value) {
			degraded = `${manifest} is absent at ${sha}`;
		} else {
			const manifestText = yield* readFileAt(sha, manifest);
			if (manifestText._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`pattern anchor: cannot read ${manifest} at ${base}: ${manifestText.reason} — every pin is UNKNOWN, never "unpinned".`,
				);
			}
			const parsed = parseCatalog(manifestText.value);
			if (parsed._tag === "Unparseable") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`pattern anchor: cannot read the catalog in ${manifest} at ${base}: ${parsed.reason} — every pin is UNKNOWN, never "unpinned".`,
				);
			}
			if (parsed.catalog === null) degraded = `${manifest} at ${sha} carries no catalog: map`;
			else catalog = parsed.catalog;
		}

		const declarations = resolveDeclarations(declarationLinesIn(text.value), catalog);
		const outcome = anchorOutcome(declarations);
		const scope = [
			`pattern anchor: read ${path} at ${sha} against ${manifest}; ${declarations.length} declared, ${count(declarations, "moved")} moved, ${count(declarations, "unpinned")} unpinned, ${count(declarations, "malformed")} malformed.`,
			...(degraded === null
				? []
				: [
						`pattern anchor: ${degraded} — every declaration reports "unpinned", which is a fact about this repository rather than a failed read.`,
					]),
		];
		return answer(emit(options, outcome, declarations, sha), scope);
	});
