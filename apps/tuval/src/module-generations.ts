/**
 * Each config load is one generation of the author's own modules. Node caches an ES module by URL
 * for the life of the process and never evicts it, so a second `import()` of an edited file answers
 * with the copy the first one read. The load stamps its number on the config module's URL, and the
 * in-thread `resolve` hook below carries that stamp onto every file the stamped module imports by
 * path, and on through what those import. The next load's stamp is a different URL, so Node reads
 * each of those files as it stands now (the founder ruling on #9667:
 * https://github.com/kamp-us/phoenix/issues/9667#issuecomment-5849904007).
 *
 * A bare specifier is never stamped. A package — the SDK, `effect`, a harness — resolves to the one
 * copy the desk already holds, so a service key or a schema class a program shares with the kernel
 * stays one module. What a reload re-reads is the author's code, not its dependencies.
 *
 * The copies a load replaces stay in Node's cache until the desk restarts. That is the accepted
 * cost of the ruling: it only grows for an author who edits while the desk runs.
 *
 * The hook also records every file it stamped under its load, so a desk can watch exactly the files
 * the config it is running was read from.
 */

import {registerHooks} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";

const STAMP = "tuval-load";

interface Generations {
	installed: boolean;
	loads: number;
	/** The files each load's hook stamped, keyed by load. Emptied by `takeGenerationFiles`. */
	readonly stamped: Map<number, Set<string>>;
}

/**
 * Held on `globalThis`, not in module scope: a config that imports app source by path can import
 * this module a second time under its own stamp, and a second copy's hook would chain onto the
 * first and number its loads from one again.
 */
const held = globalThis as {[key: symbol]: Generations | undefined};
const heldAt = Symbol.for("tuval/module-generations");
const generations: Generations = held[heldAt] ?? {installed: false, loads: 0, stamped: new Map()};
held[heldAt] = generations;

const byPath = (specifier: string): boolean =>
	specifier.startsWith("./") ||
	specifier.startsWith("../") ||
	specifier.startsWith("/") ||
	specifier.startsWith("file:");

const loadOf = (url: string | undefined): number | undefined => {
	if (url === undefined || !url.startsWith("file:")) return undefined;
	const stamp = new URL(url).searchParams.get(STAMP);
	return stamp === null ? undefined : Number(stamp);
};

/** Registered once per thread, on the first load: `registerHooks` chains every registration. */
const installHook = (): void => {
	if (generations.installed) return;
	generations.installed = true;
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			const resolved = nextResolve(specifier, context);
			const load = loadOf(context.parentURL);
			if (load === undefined || !byPath(specifier) || !resolved.url.startsWith("file:")) {
				return resolved;
			}
			generations.stamped.get(load)?.add(fileURLToPath(resolved.url));
			const url = new URL(resolved.url);
			url.searchParams.set(STAMP, String(load));
			return {...resolved, url: url.href};
		},
	});
};

/**
 * A fresh generation: the hook is in place and recording, and the answer is the number every module
 * of this load is stamped with. One load importing both config layers imports a module they share
 * exactly once.
 */
export const nextGeneration = (): number => {
	installHook();
	generations.loads += 1;
	generations.stamped.set(generations.loads, new Set());
	return generations.loads;
};

/** The URL a load imports `modulePath` at. */
export const generationUrl = (modulePath: string, load: number): string =>
	`${pathToFileURL(modulePath).href}?${STAMP}=${load}`;

/**
 * The files the hook stamped for `load`, as absolute paths, and the record dropped. Taken once the
 * load's imports have settled; a module the config imports later, at runtime, is not in it.
 */
export const takeGenerationFiles = (load: number): ReadonlyArray<string> => {
	const files = [...(generations.stamped.get(load) ?? [])].sort();
	generations.stamped.delete(load);
	return files;
};
