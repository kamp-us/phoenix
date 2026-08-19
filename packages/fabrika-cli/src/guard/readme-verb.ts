/**
 * `guard readme-guard check` — every real workspace member carries a `README.md`.
 *
 * The convention is the root `CLAUDE.md`'s: a package with no README has no entry point for a
 * reader or a consumer. Nothing enforced it and two packages drifted README-less, which is why this
 * is a gate rather than a lint.
 *
 * The verb is scope plus a rule and nothing else — the scan lives in `./members.ts`, the taxonomy
 * and the output shape in `./verdict.ts`. What is left here is the two facts this guard adds: the
 * `packages/*` glob must still be declared, and each member under it must hold a README.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {type Annotation, atFile} from "./annotate.ts";
import {scanWorkspaceMembers, undeclaredGlobs} from "./members.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard readme-guard check";

/** The convention is about `packages/*` specifically — `apps/*` and `infra/*` are out of scope. */
const GLOB = "packages/*";
const README = "README.md";

export interface ReadmeGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The report for members missing a README, and the annotations that put each on the diff.
 *
 * The annotation is anchored on the member's `package.json` rather than on the absent README: an
 * annotation needs a file that exists to render against, and the manifest is the file that proves
 * the directory is a member at all.
 */
const missingReport = (
	missing: ReadonlyArray<string>,
	scanned: number,
): {readonly report: string; readonly annotations: () => ReadonlyArray<Annotation>} => ({
	report: [
		`${VERB}: ${missing.length} ${GLOB} workspace ${missing.length === 1 ? "member lacks" : "members lack"} a ${README} (of ${scanned} scanned):`,
		...missing.map((dir) => `  ${dir}`),
		"",
		`Every ${GLOB} workspace package must carry a ${README} (what it is, why it exists, how to`,
		"use it). Add one to each listed directory.",
	].join("\n"),
	annotations: () =>
		missing.map((dir) =>
			atFile(
				"error",
				`${dir}/package.json`,
				`${dir} has no ${README} — every ${GLOB} workspace package must carry one (what it is, why it exists, how to use it). Fix: add ${dir}/${README}.`,
			),
		),
});

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const scan = yield* scanWorkspaceMembers(root, [GLOB]);
		if (undeclaredGlobs(scan.declared, [GLOB]).length > 0) {
			return zeroScope(
				`${VERB}: pnpm-workspace.yaml does not declare the \`${GLOB}\` member glob (found: ${scan.declared.join(", ") || "<none>"}) — the guard's scope assumption is broken, fail-closed (ADR 0092).`,
			);
		}
		if (scan.members.length === 0) {
			return zeroScope(
				`${VERB}: scanned ZERO ${GLOB} workspace members (no directory with a package.json) — fail-closed (ADR 0092). Is the repo root correct, or did the workspace shape change?`,
			);
		}
		const missing: Array<string> = [];
		for (const member of scan.members) {
			if (!(yield* exists(path.join(root, member.dir, README)))) missing.push(member.dir);
		}
		if (missing.length === 0) {
			return clean(
				`${VERB}: all ${scan.members.length} ${GLOB} workspace members carry a ${README}`,
				scan.members.length,
			);
		}
		const {report, annotations} = missingReport(missing, scan.members.length);
		return violation(report, annotationsOrNone(annotations));
	});

export const runReadmeGuard = (
	options: ReadmeGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judge(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
