/**
 * The guard-probe half of the ocr-port filter spike's refusal union.
 *
 * The union is **derived, not declared**: every probe path is composed out of a guard module's own
 * exported corpus constant, cited by source file, and `guard-trees.sync.unit.test.ts` re-reads each
 * cited source to assert the constant is still exported there — so a guard that moves or renames
 * its corpus reds this table instead of silently shrinking what the filter refuses to blind. The
 * governed roots are read from `.fabrika.jsonc` at runtime by the calling verb and handed in as
 * probes (`governedRootProbes`), never hardcoded here.
 *
 * Probes, not pattern algebra: a guard is represented by one or two paths it actually reads, and a
 * pattern is refused when it could match one of those. An algebraic intersection test against a
 * universe-wide surface (leak-guard's `*.md` doc sweep) would refuse every directory exclusion,
 * including the spike's own defaults — probe granularity is the reading under which the mission's
 * default exclusion set and its refusal invariant are both satisfiable.
 */
import {MANIFEST} from "../guard/catalog-verb.ts";
import {CI_CHANGES_SOURCE} from "../guard/change-detect.ts";
import {CODEOWNERS} from "../guard/codeowners-cp-verb.ts";
import {COMPONENTS_DIR} from "../guard/design-inventory-verb.ts";
import {RAW_LAYER} from "../guard/design-token-verb.ts";
import {MANIFEST_PATH} from "../guard/fanout.ts";
import {FEATURES_DIR} from "../guard/fanout-verb.ts";
import {SOURCE} from "../guard/no-gh-verb.ts";
import {WORKSPACE} from "../guard/patch-verb.ts";
import {CI_E2E_SOURCE, DEPLOY_SOURCE} from "../guard/path-filter.ts";
import {DOC as POINTER_DOC} from "../guard/pointer-verb.ts";
import {PUBLISH_WORKFLOW} from "../guard/publish-isolation-verb.ts";
import {SETTINGS} from "../guard/settings-env-verb.ts";
import {CORPUS} from "../guard/skill-lint-verb.ts";
import type {GuardProbe} from "./filter-spike.ts";

/**
 * One probe per guarded surface. The composed representatives name real files: the catalog guard's
 * manifest plus a workspace member's, the fanout manifest the guard fails closed on, the design
 * token layer, the CI changes-glob sources the path-filter guard defends, and so on.
 */
export const guardProbes = (): ReadonlyArray<GuardProbe> => [
	{guard: "catalog-guard", path: MANIFEST, source: "src/guard/catalog-verb.ts:MANIFEST"},
	{
		guard: "catalog-guard",
		path: `packages/fabrika-cli/${MANIFEST}`,
		source: "src/guard/catalog-verb.ts:MANIFEST",
	},
	{
		guard: "readme-guard",
		path: "packages/fabrika-cli/README.md",
		source: "src/guard/readme-verb.ts:GLOB",
	},
	{
		guard: "skill-lint",
		path: `${CORPUS}/fabrika/skills/review/SKILL.md`,
		source: "src/guard/skill-lint-verb.ts:CORPUS",
	},
	{guard: "no-gh", path: `${SOURCE}/bin.ts`, source: "src/guard/no-gh-verb.ts:SOURCE"},
	{guard: "settings-env-guard", path: SETTINGS, source: "src/guard/settings-env-verb.ts:SETTINGS"},
	{guard: "fanout-guard", path: MANIFEST_PATH, source: "src/guard/fanout.ts:MANIFEST_PATH"},
	{
		guard: "fanout-guard",
		path: `${FEATURES_DIR}/fate-live/live.ts`,
		source: "src/guard/fanout-verb.ts:FEATURES_DIR",
	},
	{guard: "patch-guard", path: WORKSPACE, source: "src/guard/patch-verb.ts:WORKSPACE"},
	{guard: "pointer-guard", path: POINTER_DOC, source: "src/guard/pointer-verb.ts:DOC"},
	{
		guard: "publish-isolation-guard",
		path: PUBLISH_WORKFLOW,
		source: "src/guard/publish-isolation-verb.ts:PUBLISH_WORKFLOW",
	},
	{
		guard: "path-filter-guard",
		path: CI_E2E_SOURCE.file,
		source: "src/guard/path-filter.ts:CI_E2E_SOURCE",
	},
	{
		guard: "path-filter-guard",
		path: DEPLOY_SOURCE.file,
		source: "src/guard/path-filter.ts:DEPLOY_SOURCE",
	},
	{
		guard: "change-detect-guard",
		path: CI_CHANGES_SOURCE.file,
		source: "src/guard/change-detect.ts:CI_CHANGES_SOURCE",
	},
	{guard: "codeowners-cp", path: CODEOWNERS, source: "src/guard/codeowners-cp-verb.ts:CODEOWNERS"},
	{
		guard: "design-token-guard",
		path: RAW_LAYER,
		source: "src/guard/design-token-verb.ts:RAW_LAYER",
	},
	{
		guard: "design-inventory",
		path: `${COMPONENTS_DIR}/probe.tsx`,
		source: "src/guard/design-inventory-verb.ts:COMPONENTS_DIR",
	},
];

/**
 * One probe per governed root, read from `.fabrika.jsonc` by the calling verb: a root ending in a
 * slash probes as a file under it, a bare file root (`.fabrika.jsonc`) probes as itself.
 */
export const governedRootProbes = (roots: ReadonlyArray<string>): ReadonlyArray<GuardProbe> =>
	roots.map((root) => ({
		guard: "governedRoots",
		path: root.endsWith("/") ? `${root}probe.md` : root,
		source: ".fabrika.jsonc:governedRoots",
	}));

/**
 * The refusal union the filter refuses against: the governed roots the caller's config declared,
 * and nothing else.
 *
 * Narrowed from the first spike draft's governed-roots-plus-guard-trees union after the benchmark
 * measured the over-broad form misfiring: on a real dependency-only PR in the measured corpus, the
 * caller's package.json glob refused because it grazed catalog-guard's corpus, blocking a
 * legitimate exclusion of a file that
 * is not a review gate's input. Guards are protected by the consumer split — they read the RAW
 * path list, never the filtered one — with {@link guardProbes} and the sync golden test kept as
 * the documented, drift-loud statement of what that split protects, not as a refusal input.
 */
export const refusalProbes = (governedRoots: ReadonlyArray<string>): ReadonlyArray<GuardProbe> =>
	governedRootProbes(governedRoots);
