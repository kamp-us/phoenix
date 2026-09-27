/**
 * How a config module is named to the person who wrote it.
 *
 * A binding error is read in a status line and pasted into issues, so it names the layer and the
 * path *inside* that layer's directory — never the absolute path the process happened to load. The
 * function is the enforcement site for that rule: a path that does not sit under its own base falls
 * back to the bare file name rather than leaking the machine's directory layout.
 */

import {basename, isAbsolute, relative} from "node:path";

/** Which of the two config layers a module came from (`config.ts`'s `ConfigLayers`). */
export type ConfigLayer = "global" | "project";

export interface ConfigFile {
	readonly layer: ConfigLayer;
	/** The module's path as the loader holds it. */
	readonly path: string;
	/** The home directory for the global layer, the project directory for the project layer. */
	readonly base: string;
}

export const describeFile = ({layer, path, base}: ConfigFile): string => {
	const inside = relative(base, path);
	const name =
		inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)
			? basename(path)
			: inside.split(/[\\/]/).join("/");
	return `${layer} ${name}`;
};
