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
 */
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {Console, Effect} from "effect";
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

const CSS_ROOT = join("apps", "web", "src");
const CONFIG_PATH = join("apps", "web", "src", "styles", "design-token-lint.config.json");
/** The one file where hex + raw px legitimately live — the raw-scale layer. */
const RAW_LAYER = join("apps", "web", "src", "styles", "tokens.css");

/** Repo-relative POSIX path — the key the ceilings map and reports use. */
const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

const walkCss = (dir: string, acc: Array<string>): void => {
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			walkCss(abs, acc);
		} else if (entry.name.endsWith(".css")) {
			acc.push(abs);
		}
	}
};

/** Enumerate + parse every CSS file under `apps/web/src` into the core's fact shape. */
const gatherCssFacts = (root: string): Effect.Effect<ReadonlyArray<CssFileFacts>, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, CSS_ROOT);
			const files: Array<string> = [];
			walkCss(base, files);
			const rawLayerAbs = join(root, RAW_LAYER);
			return files.map((abs): CssFileFacts => {
				const src = readFileSync(abs, "utf8");
				return {
					path: toRel(root, abs),
					isRawLayer: abs === rawLayerAbs,
					declared: parseDeclaredProperties(src),
					varRefs: parseVarReferences(src),
					hexLiterals: parseHexLiterals(src),
					rawPx: parseRawPxOverTwo(src),
				};
			});
		},
		catch: (cause) => new IoError({path: join(root, CSS_ROOT), cause}),
	});

/** Read + parse the app-side allow-list config; a missing/broken config fails closed. */
const readConfig = (root: string): Effect.Effect<DesignTokenConfig, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const configPath = join(root, CONFIG_PATH);
		const text = yield* Effect.try({
			try: () => readFileSync(configPath, "utf8"),
			catch: (cause) => new IoError({path: configPath, cause}),
		});
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
export const checkDesignTokens = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
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
export const writeBaseline = (root: string): Effect.Effect<void, IoError> =>
	Effect.gen(function* () {
		const configPath = join(root, CONFIG_PATH);
		const raw = yield* Effect.try({
			try: () => readFileSync(configPath, "utf8"),
			catch: (cause) => new IoError({path: configPath, cause}),
		});
		const files = yield* gatherCssFacts(root);
		yield* Effect.try({
			try: () => {
				// Preserve the full object (notes + allow-lists) and only replace ceilings.
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
				writeFileSync(configPath, `${JSON.stringify(parsed, null, "\t")}\n`, "utf8");
			},
			catch: (cause) => new IoError({path: configPath, cause}),
		});
		yield* Console.log(
			`design-token-guard: rewrote rawPxCeilings in ${CONFIG_PATH} from the current tree.`,
		);
	});
