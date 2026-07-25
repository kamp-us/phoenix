/**
 * The `design-token-guard` filesystem gate (issue #2170) — the IO seam behind the
 * CSS design-token checks, split from `command.ts` so it is crossable in unit tests
 * over a fake repo dir rather than only by spawning the bin (the core-in-its-own-file
 * idiom; #855).
 *
 * `checkDesignTokens` is the CI gate: it walks `apps/web/src/**\/*.css`, parses each
 * file for its declared properties / var refs / hex / raw-px facts, reads the app-side
 * allow-list config, and delegates the verdict to the pure core
 * (`design-token-guard.ts`). It fails `CheckFailed` (exit non-zero) on any undefined
 * ref / raw hex / raw-px regression, or on zero CSS files in scope (fail-closed, ADR
 * 0092). A directory/file IO failure is an `IoError` (also non-zero — both failures,
 * undistinguished, per the bin's contract).
 *
 * `writeBaseline` regenerates the `rawPxCeilings` map from the current tree (the
 * `--write-baseline` ergonomic), preserving every other config field and note.
 *
 * All directory/file/path IO goes through the Effect `FileSystem`/`Path` seam (over
 * the bin's `NodeServices.layer`), so a gate `unit` test crosses an in-memory/real fs
 * rather than welding to `node:fs` — see `.patterns/effect-platform-access.md`. A fs
 * fault folds `PlatformError` → the `IoError` this gate already carries.
 */
import {Console, Effect, FileSystem, Option, Path} from "effect";
import * as Schema from "effect/Schema";
import {
	type CssFileFacts,
	type DesignTokenConfig,
	judge,
	parseDeclaredProperties,
	parseHexLiterals,
	parseRawPxOverTwo,
	parseVarReferences,
	renderReport,
} from "./design-token-guard.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const CSS_ROOT = "apps/web/src";
const CONFIG_PATH = "apps/web/src/styles/design-token-lint.config.json";
/** The one file where hex + raw px legitimately live — the raw-scale layer. */
const RAW_LAYER = "apps/web/src/styles/tokens.css";

/** Repo-relative POSIX path — the key the ceilings map and reports use. */
const toRel = (path: Path.Path, root: string, abs: string): string =>
	path.relative(root, abs).split(path.sep).join("/");

/**
 * Enumerate every `*.css` under `base` (skipping `node_modules`/`dist`), walking the
 * tree through the `fs`/`path` seam. Iterative (an explicit stack) rather than
 * recursive; discovery order is irrelevant — the core sorts every reported list and
 * counts the rest, so the verdict is order-independent.
 *
 * Symlink semantics are load-bearing and deliberately match the pre-migration
 * `readdirSync(…, {withFileTypes: true})` walk, whose `Dirent.isDirectory()` was
 * **lstat**-based: a symlinked directory was never a directory and was never recursed
 * into. v4's `FileSystem.stat` is `fs.stat` (it FOLLOWS symlinks) and v4 exposes no
 * `lstat`, so the two arms below reconstruct the old semantics explicitly. Widening the
 * walk through a symlinked dir is fail-OPEN, not merely noisier: `judge` builds
 * `declaredUniverse` corpus-wide, so declarations behind a link can SILENCE a real
 * `undefinedRefs` red on a fail-closed CI gate (ADR 0092). Not following links also
 * keeps a symlink cycle unreachable — there is no visited-set or depth cap here.
 */
const walkCss = (fs: FileSystem.FileSystem, path: Path.Path, base: string) =>
	Effect.gen(function* () {
		const found: Array<string> = [];
		const stack = [base];
		for (;;) {
			const dir = stack.pop();
			if (dir === undefined) break;
			for (const name of yield* fs.readDirectory(dir)) {
				const abs = path.join(dir, name);
				// A failing stat is a broken symlink (or an entry racing an unlink) — skip it, as
				// the dirent walk silently did; surfacing it as `IoError` would let one dangling
				// link anywhere under the root red the whole gate.
				const stat = yield* Effect.option(fs.stat(abs));
				if (Option.isNone(stat)) continue;
				if (stat.value.type === "Directory") {
					if (name === "node_modules" || name === "dist") continue;
					// `readLink` succeeds only on a symlink, so success here means "symlinked dir".
					if (yield* Effect.isSuccess(fs.readLink(abs))) continue;
					stack.push(abs);
				} else if (name.endsWith(".css")) {
					// A symlinked .css FILE is still in scope (the dirent walk pushed it too).
					found.push(abs);
				}
			}
		}
		return found;
	});

/** Enumerate + parse every CSS file under `apps/web/src` into the core's fact shape. */
const gatherCssFacts = (
	root: string,
): Effect.Effect<ReadonlyArray<CssFileFacts>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const base = path.join(root, CSS_ROOT);
		const rawLayerAbs = path.join(root, RAW_LAYER);
		return yield* Effect.gen(function* () {
			const files = yield* walkCss(fs, path, base);
			return yield* Effect.forEach(
				files,
				(abs) =>
					fs.readFileString(abs, "utf8").pipe(
						Effect.map(
							(src): CssFileFacts => ({
								path: toRel(path, root, abs),
								isRawLayer: abs === rawLayerAbs,
								declared: parseDeclaredProperties(src),
								varRefs: parseVarReferences(src),
								hexLiterals: parseHexLiterals(src),
								rawPx: parseRawPxOverTwo(src),
							}),
						),
					),
				{concurrency: 1},
			);
		}).pipe(Effect.mapError((cause) => new IoError({path: base, cause})));
	});

/** Read + parse the app-side allow-list config; a missing/broken config fails closed. */
const readConfig = (
	root: string,
): Effect.Effect<DesignTokenConfig, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const configPath = path.join(root, CONFIG_PATH);
		const text = yield* fs
			.readFileString(configPath, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: configPath, cause})));
		const parsed = yield* Effect.try({
			try: () => JSON.parse(text) as Partial<DesignTokenConfig>,
			catch: (cause) => new IoError({path: configPath, cause}),
		});
		if (
			!Array.isArray(parsed.externalProperties) ||
			!Array.isArray(parsed.grandfatheredMissingTokens) ||
			parsed.rawPxCeilings === undefined ||
			parsed.rawPxCeilings === null ||
			typeof parsed.rawPxCeilings !== "object"
		) {
			// A present-but-malformed config is a broken scope assumption, not a vacuous
			// pass — fail closed (ADR 0092).
			return yield* Effect.fail(
				new CheckFailed({
					reason: `design-token-guard: ${CONFIG_PATH} is missing one of externalProperties / grandfatheredMissingTokens / rawPxCeilings — the allow-list is broken, fail-closed (ADR 0092).`,
				}),
			);
		}
		return {
			externalProperties: parsed.externalProperties,
			grandfatheredMissingTokens: parsed.grandfatheredMissingTokens,
			rawPxCeilings: parsed.rawPxCeilings,
		};
	});

/**
 * The CI gate: succeed when the design-token seam holds (every var ref resolves, no
 * raw hex outside the raw layer, no raw-px regression), else `CheckFailed`. Fails
 * closed on zero CSS files in scope (ADR 0092).
 */
export const checkDesignTokens = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const config = yield* readConfig(root);
		const files = yield* gatherCssFacts(root);
		const verdict = judge({files, config});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});

/**
 * Regenerate the `rawPxCeilings` map from the current tree and rewrite the config
 * JSON, preserving every other field (allow-lists + notes) and key order. The
 * `--write-baseline` ergonomic: after a genuine cleanup leg, snapshot the new raw-px
 * floor so the ratchet stays tight (like a snapshot-test update).
 */
export const writeBaseline = (
	root: string,
): Effect.Effect<void, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const configPath = path.join(root, CONFIG_PATH);
		const raw = yield* fs
			.readFileString(configPath, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: configPath, cause})));
		const files = yield* gatherCssFacts(root);
		// Preserve the full object (notes + allow-lists) and only replace ceilings.
		const next = yield* Effect.try({
			try: () => {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				const ceilings: Record<string, number> = {};
				for (const f of files) {
					if (f.isRawLayer) continue;
					const count = f.rawPx.length;
					if (count > 0) ceilings[f.path] = count;
				}
				const sorted = Object.fromEntries(
					Object.entries(ceilings).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
				);
				parsed.rawPxCeilings = sorted;
				return `${JSON.stringify(parsed, null, "\t")}\n`;
			},
			catch: (cause) => new IoError({path: configPath, cause}),
		});
		yield* fs
			.writeFileString(configPath, next)
			.pipe(Effect.mapError((cause) => new IoError({path: configPath, cause})));
		yield* Console.log(
			`design-token-guard: rewrote rawPxCeilings in ${CONFIG_PATH} from the current tree.`,
		);
	});
