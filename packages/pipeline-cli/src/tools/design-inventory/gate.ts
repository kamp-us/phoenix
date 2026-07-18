/**
 * The `design-inventory` filesystem gate — the IO seam behind #3155's descriptive
 * component-inventory extractor (epic #3150, ADR 0194), split from `command.ts` so it is
 * crossable in unit tests over a fake repo dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom shared with `readme-guard` / `design-token-guard`).
 *
 * Two run modes:
 *   - `generateInventory` reads the annotated `components/ui` primitives, builds the
 *     inventory via the pure core, and — through the firewall — WRITES the descriptive
 *     artifact (or, `--stdout`, prints it; or, `--check`, reds on drift without writing).
 *   - the write always routes through `writeDescriptiveArtifact`, which refuses any target
 *     but the descriptive inventory (ADR 0194) — the manifest can never be written here.
 *
 * Fail-closed on zero scope (ADR 0092): zero annotated primitives is a `CheckFailed`, not a
 * vacuous empty index. IO faults surface as `IoError`. Both exit non-zero, undistinguished.
 */
import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	buildInventory,
	INVENTORY_ARTIFACT,
	isDescriptiveWriteTarget,
	renderInventory,
	type SourceFile,
} from "./design-inventory.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/**
 * A firewall breach: a write was attempted at a target the descriptive/normative firewall
 * forbids (ADR 0194). Unreachable on the normal path — the gate only ever writes the
 * inventory artifact — but represented so the boundary is a typed refusal, not a convention.
 */
export class FirewallViolation extends Schema.TaggedErrorClass<FirewallViolation>()(
	"FirewallViolation",
	{path: Schema.String},
) {}

/** The primitives directory the inventory is extracted from (ADR 0194 / epic #3150). */
const COMPONENTS_DIR = join("apps", "web", "src", "components", "ui");

/** A `components/ui` source file to extract — a `.tsx` primitive, never a `.test.tsx` or `.css`. */
const isPrimitiveSource = (name: string): boolean =>
	name.endsWith(".tsx") && !name.endsWith(".test.tsx");

/**
 * Read every annotated `components/ui` primitive into the pure core's `SourceFile` shape.
 * Paths are repo-relative (POSIX separators) so the emitted `_Source:_` links and the sort
 * key are stable across platforms and independent of the absolute worktree root.
 */
const readComponentSources = (root: string): Effect.Effect<ReadonlyArray<SourceFile>, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, COMPONENTS_DIR);
			const files: Array<SourceFile> = [];
			for (const name of readdirSync(base)) {
				if (!isPrimitiveSource(name)) continue;
				const abs = join(base, name);
				files.push({
					path: `${COMPONENTS_DIR.split(/[/\\]/).join("/")}/${name}`,
					content: readFileSync(abs, "utf8"),
				});
			}
			return files;
		},
		catch: (cause) => new IoError({path: join(root, COMPONENTS_DIR), cause}),
	});

/**
 * Write `content` to a repo-relative target — but only if the firewall admits it (ADR 0194).
 * A non-descriptive target (above all `design-system-manifest.md`) is a `FirewallViolation`,
 * never a write. This is the single write seam the tool exposes; the manifest has no path here.
 */
export const writeDescriptiveArtifact = (
	root: string,
	relPath: string,
	content: string,
): Effect.Effect<void, IoError | FirewallViolation> =>
	Effect.gen(function* () {
		if (!isDescriptiveWriteTarget(relPath)) {
			return yield* Effect.fail(new FirewallViolation({path: relPath}));
		}
		yield* Effect.try({
			try: () => writeFileSync(join(root, relPath), content, "utf8"),
			catch: (cause) => new IoError({path: join(root, relPath), cause}),
		});
	});

/** Run options: `stdout` prints instead of writing; `check` reds on drift instead of writing. */
export interface GenerateOptions {
	readonly stdout: boolean;
	readonly check: boolean;
}

/**
 * The extractor run: build the descriptive inventory over the annotated primitives, then
 * emit it per the mode. `--check` compares against the committed artifact and `CheckFailed`s
 * on drift (the self-updating loop's freshness signal, wired into CI by #3156); `--stdout`
 * prints; the default writes the artifact through the firewall. Fails closed on zero scope.
 */
export const generateInventory = (
	root: string,
	options: GenerateOptions,
): Effect.Effect<void, IoError | CheckFailed | FirewallViolation> =>
	Effect.gen(function* () {
		const sources = yield* readComponentSources(root);
		const result = buildInventory(sources);
		if (!result.pass) {
			return yield* Effect.fail(
				new CheckFailed({
					reason:
						`design-inventory: scanned ZERO annotated primitives under ${COMPONENTS_DIR} — ` +
						"fail-closed (ADR 0092). Is the repo root correct, or did the @component convention drop?",
				}),
			);
		}
		const rendered = renderInventory(result.entries);

		if (options.stdout) {
			yield* Console.log(rendered);
			return;
		}

		if (options.check) {
			const artifactPath = join(root, INVENTORY_ARTIFACT);
			const existing = existsSync(artifactPath)
				? yield* Effect.try({
						try: () => readFileSync(artifactPath, "utf8"),
						catch: (cause) => new IoError({path: artifactPath, cause}),
					})
				: null;
			if (existing !== rendered) {
				return yield* Effect.fail(
					new CheckFailed({
						reason:
							`design-inventory: ${INVENTORY_ARTIFACT} is out of date with the primitives' JSDoc ` +
							"(or missing) — run `pipeline-cli design-inventory generate` and commit the result.",
					}),
				);
			}
			yield* Console.log(
				`design-inventory: ${INVENTORY_ARTIFACT} is fresh (${result.entries.length} primitives).`,
			);
			return;
		}

		yield* writeDescriptiveArtifact(root, INVENTORY_ARTIFACT, rendered);
		yield* Console.log(
			`design-inventory: wrote ${INVENTORY_ARTIFACT} (${result.entries.length} primitives).`,
		);
	});
