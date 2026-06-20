/**
 * `@kampus/publish-guard` — the deterministic floor for "which `@kampus/*`
 * packages the plugin consumes must be publishable" (epic #803, child #807).
 *
 * The core is two pure-cored modules: `required.ts` derives the consumed set by
 * scanning the skills tree (`requiredPackages` / `extractKampusRefs`), and
 * `drift.ts` cross-checks each one's `package.json` for publishability offline
 * (`checkDrift` over loaded manifests). `bin.ts` wires them to an
 * `effect/unstable/cli` with `list` and `check` subcommands. It is a CI tool run
 * from source (`node src/bin.ts`), the `leak-guard`/`ci-required` idiom — itself
 * not in the required-published set (epic #803 Resolved questions).
 */

export {
	checkDrift,
	type DriftReport,
	type DriftStatus,
	loadManifests,
	loadPackageManifest,
	type PackageManifest,
	type PackageVerdict,
} from "./drift.ts";
export {
	extractKampusRefs,
	extractUnpublishedInvocations,
	requiredPackages,
	unpublishedInvocationBreaks,
} from "./required.ts";
