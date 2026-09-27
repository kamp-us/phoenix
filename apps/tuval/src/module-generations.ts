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
 * The hooks also record every file stamped under a load, so a desk can watch exactly the files the
 * config it is running was read from, and the source each was compiled from beside the files it
 * imports by path, so a reload can tell which files a program row's code stands on
 * (`./authored-modules.ts`).
 */

import {registerHooks} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";
import {AuthoredModules} from "./authored-modules.ts";

const STAMP = "tuval-load";

/** What the hooks recorded under one load. */
interface Recorded {
	/** The files the `resolve` hook stamped: every file the load imported by path, not its roots. */
	readonly files: Set<string>;
	/** Every stamped file's source as its `load` hook saw it, the load's root modules among them. */
	readonly sources: Map<string, string>;
	/** Each stamped file beside the stamped files it imports by path. */
	readonly imports: Map<string, Set<string>>;
}

interface Generations {
	installed: boolean;
	loads: number;
	/** What each load's hooks recorded, keyed by load. Emptied by `takeGeneration`. */
	readonly recorded: Map<number, Recorded>;
}

/**
 * Held on `globalThis`, not in module scope: a config that imports app source by path can import
 * this module a second time under its own stamp, and a second copy's hook would chain onto the
 * first and number its loads from one again.
 */
const held = globalThis as {[key: symbol]: Generations | undefined};
const heldAt = Symbol.for("tuval/module-generations");
const generations: Generations = held[heldAt] ?? {installed: false, loads: 0, recorded: new Map()};
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
			if (
				load === undefined ||
				context.parentURL === undefined ||
				!byPath(specifier) ||
				!resolved.url.startsWith("file:")
			) {
				return resolved;
			}
			const recorded = generations.recorded.get(load);
			if (recorded !== undefined) {
				const file = fileURLToPath(resolved.url);
				const parent = fileURLToPath(context.parentURL);
				recorded.files.add(file);
				const imports = recorded.imports.get(parent) ?? new Set();
				imports.add(file);
				recorded.imports.set(parent, imports);
			}
			const url = new URL(resolved.url);
			url.searchParams.set(STAMP, String(load));
			return {...resolved, url: url.href};
		},
		load: (url, context, nextLoad) => {
			const loaded = nextLoad(url, context);
			const load = loadOf(url);
			if (load === undefined) return loaded;
			const {source} = loaded;
			const text =
				typeof source === "string"
					? source
					: source instanceof ArrayBuffer || ArrayBuffer.isView(source)
						? decoder.decode(source)
						: undefined;
			if (text !== undefined) generations.recorded.get(load)?.sources.set(fileURLToPath(url), text);
			return loaded;
		},
	});
};

const decoder = new TextDecoder();

/**
 * A fresh generation: the hook is in place and recording, and the answer is the number every module
 * of this load is stamped with. One load importing both config layers imports a module they share
 * exactly once.
 */
export const nextGeneration = (): number => {
	installHook();
	generations.loads += 1;
	generations.recorded.set(generations.loads, {
		files: new Set(),
		sources: new Map(),
		imports: new Map(),
	});
	return generations.loads;
};

/** The URL a load imports `modulePath` at. */
export const generationUrl = (modulePath: string, load: number): string =>
	`${pathToFileURL(modulePath).href}?${STAMP}=${load}`;

/** What one load read of the author's own code. */
export interface Generation {
	/** The files the load imported by path, as absolute paths, sorted; the root modules are not in it. */
	readonly files: ReadonlyArray<string>;
	readonly modules: AuthoredModules;
}

/**
 * What the hooks recorded for `load`, and the record dropped. Taken once the load's imports have
 * settled; a module the config imports later, at runtime, is not in it.
 */
export const takeGeneration = (load: number): Generation => {
	const recorded = generations.recorded.get(load);
	generations.recorded.delete(load);
	if (recorded === undefined) return {files: [], modules: AuthoredModules.none};
	return {
		files: [...recorded.files].sort(),
		// No source seen: a loader that bypasses Node's, as Vitest's runner does, runs no hook.
		modules:
			recorded.sources.size === 0
				? AuthoredModules.none
				: new AuthoredModules(recorded.sources, recorded.imports),
	};
};
