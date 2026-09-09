/**
 * The `piSubagents` flag, turned into the one thing the session host takes: a list of extension
 * package directories, empty when the flag is off.
 *
 * A *directory* rather than an import, because `pi-subagents` ships raw TypeScript
 * (`exports: {".": "./index.ts"}`) and Node refuses to strip types under `node_modules`. Pi loads
 * its own extensions through jiti off a path (`pi-coding-agent` `dist/core/extensions/loader.js`),
 * and a package directory is what its resolver reads a `pi` manifest out of
 * (`dist/core/package-manager.js`: a local source that stats as a directory goes to
 * `collectPackageResources`) — so the extension, its skills and its prompts all arrive from one
 * entry, and nothing in Tuval ever imports the package.
 */

import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import type {TuvalFeatures} from "../../features.ts";

/** The npm package, unscoped — it is not one of the `@earendil-works/*` family (#8555). */
export const SUBAGENTS_PACKAGE = "pi-subagents";

/**
 * Where the installed `pi-subagents` lives, resolved through its own export map rather than by
 * walking up to a `node_modules`: pnpm's store means the directory beside this file is not the one
 * the package resolves to.
 */
export const subagentsPackageDir = (): string =>
	dirname(fileURLToPath(import.meta.resolve(SUBAGENTS_PACKAGE)));

/**
 * The extension paths a session opens with. Off is an empty list and not a disabled extension: the
 * host builds no resource loader of its own for one, which leaves `createAgentSession` building
 * exactly the loader it built before this flag existed.
 */
export const subagentExtensionPaths = (
	features: Pick<TuvalFeatures, "piSubagents">,
): ReadonlyArray<string> => (features.piSubagents ? [subagentsPackageDir()] : []);
