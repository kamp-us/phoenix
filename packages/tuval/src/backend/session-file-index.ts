import type {Dirent, Stats} from "node:fs";
import {lstat, readdir, realpath} from "node:fs/promises";
import {isAbsolute, join, relative, resolve, sep} from "node:path";

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ENTRIES = 100_000;

export interface SessionFileIndexProblem {
	readonly source: string;
	readonly message: string;
}

export interface SessionFileIndex {
	readonly files: ReadonlyArray<string>;
	readonly problems: ReadonlyArray<SessionFileIndexProblem>;
}

export interface SessionFileIndexOptions {
	readonly maxDepth?: number;
	readonly maxEntries?: number;
}

const containedBy = (root: string, candidate: string): boolean => {
	const nested = relative(root, candidate);
	return (
		nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
	);
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const indexSessionFiles = async (
	root: string,
	options: SessionFileIndexOptions = {},
): Promise<SessionFileIndex> => {
	const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
	const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
	const requestedRoot = resolve(root);
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(requestedRoot);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return {files: [], problems: []};
		}
		return {files: [], problems: [{source: requestedRoot, message: messageOf(error)}]};
	}
	const files = new Set<string>();
	const problems: Array<SessionFileIndexProblem> = [];
	const pending: Array<{readonly directory: string; readonly depth: number}> = [
		{directory: canonicalRoot, depth: 0},
	];
	let visitedEntries = 0;
	let entryLimitReached = false;

	while (pending.length > 0 && visitedEntries < maxEntries) {
		const current = pending.pop();
		if (current === undefined) break;
		let canonicalDirectory: string;
		try {
			canonicalDirectory = await realpath(current.directory);
			if (!containedBy(canonicalRoot, canonicalDirectory)) {
				problems.push({
					source: current.directory,
					message: "session directory resolves outside the configured root",
				});
				continue;
			}
		} catch (error) {
			problems.push({source: current.directory, message: messageOf(error)});
			continue;
		}

		let entries: Array<Dirent>;
		try {
			entries = await readdir(canonicalDirectory, {withFileTypes: true});
		} catch (error) {
			problems.push({source: canonicalDirectory, message: messageOf(error)});
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (visitedEntries >= maxEntries) {
				entryLimitReached = true;
				break;
			}
			visitedEntries += 1;
			const entryPath = join(canonicalDirectory, entry.name);
			let info: Stats;
			try {
				info = await lstat(entryPath);
			} catch (error) {
				problems.push({source: entryPath, message: messageOf(error)});
				continue;
			}
			if (info.isSymbolicLink()) continue;
			if (info.isFile()) {
				if (entry.name.endsWith(".jsonl")) files.add(entryPath);
				continue;
			}
			if (!info.isDirectory()) continue;
			if (current.depth >= maxDepth) {
				problems.push({
					source: entryPath,
					message: `session traversal depth limit ${maxDepth} reached`,
				});
				continue;
			}
			pending.push({directory: entryPath, depth: current.depth + 1});
		}
	}

	if (visitedEntries >= maxEntries && (pending.length > 0 || entryLimitReached)) {
		problems.push({
			source: canonicalRoot,
			message: `session traversal entry limit ${maxEntries} reached`,
		});
	}
	return {
		files: [...files].sort((left, right) => left.localeCompare(right)),
		problems: problems.sort((left, right) => left.source.localeCompare(right.source)),
	};
};
