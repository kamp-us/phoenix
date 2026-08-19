/**
 * The Node-resolver boundary for the delegation.
 *
 * **No `effect` import here on purpose.** `createRequire(…).resolve` reports "not installed" by
 * *throwing*, and the repo bans a native `try/catch` inside Effect control flow (#2736) — so this is
 * the boundary half, mirroring [`../io/json.ts`](../io/json.ts), and [`local.ts`](./local.ts) is the
 * Effect seam that wraps it. Every outcome leaves as a value; nothing propagates as a throw except a
 * fault this module genuinely cannot classify.
 */
import {createRequire} from "node:module";
import {type RepoPredicate, repoPredicate} from "./reason.ts";

export type ResolveOutcome =
	| {readonly _tag: "resolved"; readonly manifestPath: string}
	| {readonly _tag: "absent"}
	| {readonly _tag: "corrupt"; readonly reason: RepoPredicate};

/**
 * Where `packageName`'s manifest is, resolved from `rootManifest` the way Node itself would.
 *
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` is an installed-but-unusable copy, not an absent one: a version
 * predating this package's `"./package.json"` export is on disk and cannot be introspected. It takes
 * the corrupt branch so the developer is told to reinstall, rather than silently getting the global.
 */
export const resolvePackageManifest = (
	rootManifest: string,
	packageName: string,
): ResolveOutcome => {
	try {
		return {
			_tag: "resolved",
			manifestPath: createRequire(rootManifest).resolve(`${packageName}/package.json`),
		};
	} catch (error) {
		const code = (error as {code?: unknown} | null)?.code;
		if (code === "MODULE_NOT_FOUND") return {_tag: "absent"};
		if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
			return {
				_tag: "corrupt",
				reason: repoPredicate`has an ${packageName} install too old to introspect (it does not export "./package.json")`,
			};
		return {
			_tag: "corrupt",
			reason: repoPredicate`could not resolve ${packageName}: ${String(error)}`,
		};
	}
};
