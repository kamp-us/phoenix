/**
 * `guard design-token-guard check` — ported off v1's `design-token-guard check` (epic #5720).
 *
 * The verb is the IO boundary: walk the consuming app and `@kampus/design` for CSS, parse each
 * file's facts, read the package-owned allow-list config, hand both to the pure rule in
 * `./design-token.ts`, seat the answer on
 * the group's exit taxonomy. `--write-baseline` is the one write mode — it re-snapshots the raw-px
 * ceilings after a genuine cleanup leg, the way a snapshot test is updated.
 */

import {Effect, FileSystem, Option, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {type ReadFailed, readDir, readFile, type WriteFailed, writeFile} from "../io/fs.ts";
import {parseJson} from "../io/json.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import {atLine} from "./annotate.ts";
import {
	type CssFileFacts,
	type DesignTokenConfig,
	judge,
	parseDeclaredProperties,
	parseHexLiterals,
	parseRawPxOverTwo,
	parseVarReferences,
	renderReport,
} from "./design-token.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard design-token-guard check";

const CSS_ROOTS = ["apps/web/src", "packages/design/src"] as const;
const CONFIG_PATH = "packages/design/design-token-lint.config.json";
/** The one file where hex and raw px legitimately live — the raw-scale layer. */
const RAW_LAYER = "packages/design/src/tokens.css";

export interface DesignTokenGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Re-snapshot the raw-px ceilings from this tree instead of judging it. */
	readonly writeBaseline: boolean;
}

/**
 * Every `*.css` under `base`, skipping `node_modules`/`dist`.
 *
 * **A symlinked directory is not recursed into, deliberately.** `judge` builds its
 * `declaredUniverse` corpus-wide, so a declaration reached through a link can SILENCE a real dead
 * ref — widening the walk is fail-OPEN on a fail-closed gate. Not following links also makes a
 * symlink cycle unreachable, which is why there is no visited set here. `FileSystem.stat` follows
 * symlinks and Effect exposes no `lstat`, so the `readLink` probe below is what distinguishes them.
 *
 * A failing stat is a dangling link (or an entry racing an unlink): a `*.css` one is pushed anyway
 * so it reds at the read, because a CSS file replaced by a dangling link must not silently leave
 * scope. A directory that cannot be LISTED is a different thing and fails the walk: swallowing it
 * shrinks the corpus while `judge` still sees files elsewhere and passes, which is a clean verdict
 * over a scan that silently narrowed (ADR 0092).
 */
const walkCss = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	base: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const found: Array<string> = [];
		const stack = [base];
		for (;;) {
			const dir = stack.pop();
			if (dir === undefined) break;
			const names = yield* readDir(dir);
			for (const name of names) {
				const abs = path.join(dir, name);
				const stat = yield* Effect.option(fs.stat(abs));
				if (Option.isNone(stat)) {
					if (name.endsWith(".css")) found.push(abs);
					continue;
				}
				if (stat.value.type === "Directory") {
					if (name === "node_modules" || name === "dist") continue;
					if (yield* Effect.isSuccess(fs.readLink(abs))) continue;
					stack.push(abs);
				} else if (name.endsWith(".css")) {
					found.push(abs);
				}
			}
		}
		return found;
	});

/** Repo-relative POSIX path — the key the ceilings map and the reports use. */
const toRel = (path: Path.Path, root: string, abs: string): string =>
	path.relative(root, abs).split(path.sep).join("/");

const gatherCssFacts = (
	root: string,
): Effect.Effect<ReadonlyArray<CssFileFacts>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const rawLayerAbs = path.join(root, RAW_LAYER);
		const files: Array<string> = [];
		for (const cssRoot of CSS_ROOTS) {
			files.push(...(yield* walkCss(fs, path, path.join(root, cssRoot))));
		}
		const facts: Array<CssFileFacts> = [];
		for (const abs of files) {
			const src = yield* readFile(abs);
			facts.push({
				path: toRel(path, root, abs),
				isRawLayer: abs === rawLayerAbs,
				declared: parseDeclaredProperties(src),
				varRefs: parseVarReferences(src),
				hexLiterals: parseHexLiterals(src),
				rawPx: parseRawPxOverTwo(src),
			});
		}
		return facts;
	});

/** The parsed allow-list config, or the named reason it is unusable. */
type ConfigRead =
	| {readonly _tag: "Config"; readonly config: DesignTokenConfig}
	| {readonly _tag: "Malformed"; readonly report: string};

const readConfig = (
	root: string,
): Effect.Effect<ConfigRead, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const parsed = parseJson(
			yield* readFile(path.join(root, CONFIG_PATH)),
		) as Partial<DesignTokenConfig> | null;
		if (
			parsed === null ||
			!Array.isArray(parsed.externalProperties) ||
			!Array.isArray(parsed.grandfatheredMissingTokens) ||
			typeof parsed.rawPxCeilings !== "object" ||
			parsed.rawPxCeilings === null
		) {
			return {
				_tag: "Malformed",
				report: `${VERB}: ${CONFIG_PATH} does not parse, or is missing one of externalProperties / grandfatheredMissingTokens / rawPxCeilings — the allow-list the ratchet is judged against is broken, fail-closed (ADR 0092).`,
			};
		}
		return {
			_tag: "Config",
			config: {
				externalProperties: parsed.externalProperties,
				grandfatheredMissingTokens: parsed.grandfatheredMissingTokens,
				rawPxCeilings: parsed.rawPxCeilings,
			},
		};
	});

const judgeTree = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const config = yield* readConfig(root);
		if (config._tag === "Malformed") return zeroScope(config.report);
		const files = yield* gatherCssFacts(root);
		const verdict = judge({files, config: config.config});
		const report = renderReport(verdict);
		if (verdict.pass) return clean(report, verdict.filesChecked);
		if (verdict.reason === "zero-scope") return zeroScope(report);
		return violation(
			report,
			annotationsOrNone(() => [
				...verdict.undefinedRefs.map((r) =>
					atLine(
						"error",
						r.path,
						r.line,
						`var(${r.name}) resolves to no declared, injected or grandfathered property — it renders unstyled with nothing failing (#2167). Fix: use an existing role token, or declare it.`,
					),
				),
				...verdict.hex.map((h) =>
					atLine(
						"error",
						h.path,
						h.line,
						`the raw hex ${h.value} lives outside the raw-scale layer — hex belongs only in ${RAW_LAYER} (ADR 0162, Pillar 2). Fix: reach for a role token.`,
					),
				),
				...verdict.rawPx.flatMap((p) =>
					p.samples.map((s) =>
						atLine(
							"error",
							p.path,
							s.line,
							`${s.value} bypasses the 4px spacing seam and this file is over its ceiling (${p.count} > ${p.ceiling ?? 0}, ADR 0162 value #1). Fix: use a --s-N spacing token.`,
						),
					),
				),
			]),
		);
	});

/**
 * Re-snapshot `rawPxCeilings` from the current tree, preserving every other config field and its
 * notes — the `--write-baseline` ergonomic, run after a real cleanup leg so the ratchet stays tight.
 */
const rewriteBaseline = (
	root: string,
): Effect.Effect<VerbOutcome, ReadFailed | WriteFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const configPath = path.join(root, CONFIG_PATH);
		const parsed = parseJson(yield* readFile(configPath)) as Record<string, unknown> | null;
		if (parsed === null) {
			return emitVerdict(
				unknown(`${VERB}: ${CONFIG_PATH} does not parse as JSON — refusing to rewrite it.`),
				{},
			);
		}
		const files = yield* gatherCssFacts(root);
		const ceilings: Record<string, number> = {};
		for (const f of files) {
			if (f.isRawLayer) continue;
			if (f.rawPx.length > 0) ceilings[f.path] = f.rawPx.length;
		}
		parsed.rawPxCeilings = Object.fromEntries(
			Object.entries(ceilings).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		);
		yield* writeFile(configPath, `${JSON.stringify(parsed, null, "\t")}\n`);
		return answer(
			`${VERB}: rewrote rawPxCeilings in ${CONFIG_PATH} from the current tree (${Object.keys(ceilings).length} file(s) with raw px > 2px).\n`,
		);
	});

export const runDesignTokenGuard = (
	options: DesignTokenGuardOptions,
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
		if (options.writeBaseline) return yield* rewriteBaseline(root);
		return emitVerdict(yield* judgeTree(root), options.env);
	}).pipe(
		Effect.catchTags({
			"fabrika-cli/ReadFailed": (failure) =>
				Effect.succeed(
					emitVerdict(
						unknown(
							`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
						),
						options.env,
					),
				),
			"fabrika-cli/WriteFailed": (failure) =>
				Effect.succeed(
					emitVerdict(
						unknown(
							`${VERB}: cannot write ${failure.path}: ${failure.reason} — nothing was changed.`,
						),
						options.env,
					),
				),
		}),
	);
