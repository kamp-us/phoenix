/**
 * `guard design-inventory check` / `generate` — ported off v1's `design-inventory` (epic
 * #5720).
 *
 * The verb is the IO boundary: read the annotated `packages/design/src` primitives, build the inventory
 * through the pure core in `./design-inventory.ts`, then either compare it against the committed
 * artifact (`check`) or write it (`generate`).
 *
 * **The two modes travel together.** `check` is only meaningful because `generate` is the one thing
 * that produces what it compares against; a `generate` that no longer matches `check` is worse than
 * neither, because CI would then red on a file no command can fix. Every write routes through the
 * core's firewall predicate, so the founder-authored normative manifest has no path here at all.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readDir, readFile, type WriteFailed, writeFile} from "../io/fs.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {
	buildInventory,
	INVENTORY_ARTIFACT,
	isDescriptiveWriteTarget,
	NORMATIVE_MANIFEST,
	renderInventory,
	type SourceFile,
} from "./design-inventory.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const CHECK_VERB = "guard design-inventory check";
const GENERATE_VERB = "guard design-inventory generate";

/** The primitives directory the inventory is extracted from (ADR 0194). */
const COMPONENTS_DIR = "packages/design/src";

export interface DesignInventoryOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** A `.tsx` primitive — never a `.test.tsx` or a `.css`. */
const isPrimitiveSource = (name: string): boolean =>
	name.endsWith(".tsx") && !name.endsWith(".test.tsx");

/**
 * Read every primitive into the core's shape. Paths are repo-relative POSIX so the emitted
 * `_Source:_` links and the sort key are identical on every platform and every worktree root.
 */
const readComponentSources = (
	root: string,
): Effect.Effect<ReadonlyArray<SourceFile>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const base = path.join(root, COMPONENTS_DIR);
		if (!(yield* exists(base))) return [];
		const names = (yield* readDir(base)).filter(isPrimitiveSource).sort();
		const files: Array<SourceFile> = [];
		for (const name of names) {
			files.push({
				path: `${COMPONENTS_DIR}/${name}`,
				content: yield* readFile(path.join(base, name)),
			});
		}
		return files;
	});

const zeroScopeReport = (verb: string): string =>
	`${verb}: scanned ZERO annotated primitives under ${COMPONENTS_DIR} — fail-closed (ADR 0092). Is the repo root correct, or did the @component convention drop?`;

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const result = buildInventory(yield* readComponentSources(root));
		if (!result.pass) return zeroScope(zeroScopeReport(CHECK_VERB));
		const rendered = renderInventory(result.entries);
		const artifact = path.join(root, INVENTORY_ARTIFACT);
		const committed = (yield* exists(artifact)) ? yield* readFile(artifact) : null;
		if (committed === rendered) {
			return clean(
				`${CHECK_VERB}: ${INVENTORY_ARTIFACT} is fresh (${result.entries.length} primitives)`,
				result.entries.length,
			);
		}
		const report =
			`${CHECK_VERB}: ${INVENTORY_ARTIFACT} ${committed === null ? "is missing" : "has drifted from the primitives' JSDoc"} — ` +
			`the committed inventory no longer describes what ${COMPONENTS_DIR} actually ships, so every agent reading it is reading a stale map.\n\n` +
			`Fix: run \`node packages/fabrika-cli/src/bin.ts ${GENERATE_VERB}\` and commit the result.`;
		return violation(
			report,
			annotationsOrNone(() => [
				atFile(
					"error",
					INVENTORY_ARTIFACT,
					`the descriptive inventory is stale against the JSDoc on ${COMPONENTS_DIR} (ADR 0194). Fix: regenerate it with \`fabrika ${GENERATE_VERB}\` and commit.`,
				),
			]),
		);
	});

export const runDesignInventoryCheck = (
	options: DesignInventoryOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* resolveRoot(options);
		if (root === null) return noRoot(CHECK_VERB, options);
		return emitVerdict(yield* judge(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (f) =>
			Effect.succeed(readUnknown(CHECK_VERB, f, options)),
		),
	);

/**
 * Write the inventory — the only write this group performs, and it goes through the firewall.
 *
 * The refusal arm is unreachable on this path (the target is the const the predicate admits), and it
 * is represented anyway so the boundary is a typed refusal rather than a convention a later edit
 * could quietly step over.
 */
export const runDesignInventoryGenerate = (
	options: DesignInventoryOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* resolveRoot(options);
		if (root === null) return noRoot(GENERATE_VERB, options);
		const path = yield* Path.Path;
		const result = buildInventory(yield* readComponentSources(root));
		if (!result.pass) {
			return emitVerdict(zeroScope(zeroScopeReport(GENERATE_VERB)), options.env);
		}
		if (!isDescriptiveWriteTarget(INVENTORY_ARTIFACT)) {
			return emitVerdict(
				unknown(
					`${GENERATE_VERB}: refused to write ${INVENTORY_ARTIFACT} — only the descriptive inventory is writable here, never ${NORMATIVE_MANIFEST} (ADR 0194).`,
				),
				options.env,
			);
		}
		yield* writeFile(path.join(root, INVENTORY_ARTIFACT), renderInventory(result.entries));
		return answer(
			`${GENERATE_VERB}: wrote ${INVENTORY_ARTIFACT} (${result.entries.length} primitives).\n`,
		);
	}).pipe(
		Effect.catchTags({
			"fabrika-cli/ReadFailed": (f) => Effect.succeed(readUnknown(GENERATE_VERB, f, options)),
			"fabrika-cli/WriteFailed": (f: WriteFailed) =>
				Effect.succeed(
					emitVerdict(
						unknown(
							`${GENERATE_VERB}: cannot write ${f.path}: ${f.reason} — the inventory was not updated.`,
						),
						options.env,
					),
				),
		}),
	);

const resolveRoot = (
	options: DesignInventoryOptions,
): Effect.Effect<string | null, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	options.root !== null
		? Effect.succeed(options.root)
		: discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null));

const noRoot = (verb: string, options: DesignInventoryOptions): VerbOutcome =>
	emitVerdict(
		unknown(
			`${verb}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
		),
		options.env,
	);

const readUnknown = (
	verb: string,
	failure: ReadFailed,
	options: DesignInventoryOptions,
): VerbOutcome =>
	emitVerdict(
		unknown(
			`${verb}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
		),
		options.env,
	);
