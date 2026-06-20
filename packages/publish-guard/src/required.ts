/**
 * `@kampus/publish-guard` core — derive the set of `@kampus/*` packages the
 * kampus-pipeline plugin *consumes*, by scanning the skills tree for references
 * (epic #803, child #807).
 *
 * This derivation IS the single source of truth for "which packages must be
 * published" — there is no second hand-maintained manifest to drift (epic #803
 * Resolved questions). The match is the literal token `@kampus/<name>` anywhere
 * in a skill file's text; `<name>` is a package slug (`[a-z0-9-]+`).
 *
 * The pure half — `extractKampusRefs(text)` — is IO-free and fixture-tested. The
 * IO half — `requiredPackages(skillsDir)` — walks the directory and folds every
 * file's refs into one sorted, deduped set, so it is deterministic over a fixed
 * tree (no network, no clock).
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";

// `@kampus/<slug>` where slug is a lowercase npm package name segment. The
// negative-lookbehind-free form is fine: we want every textual occurrence.
const KAMPUS_REF = /@kampus\/([a-z0-9-]+)/g;

/** Every distinct `@kampus/<name>` slug referenced in `text` (just the `<name>`). */
export const extractKampusRefs = (text: string): ReadonlyArray<string> => {
	if (!text) return [];
	const seen = new Set<string>();
	for (const match of text.matchAll(KAMPUS_REF)) {
		const name = match[1];
		if (name) seen.add(name);
	}
	return [...seen].sort();
};

/** Recursively collect every file path under `dir` (files only, dirs descended). */
const walkFiles = (dir: string): ReadonlyArray<string> => {
	let entries: ReadonlyArray<string>;
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry);
		let isDir: boolean;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) files.push(...walkFiles(full));
		else files.push(full);
	}
	return files;
};

/**
 * The sorted, deduped set of `@kampus/*` package names referenced anywhere under
 * `skillsDir`. A missing/unreadable dir yields `[]` (the caller decides whether
 * an empty derived set is itself a problem — `bin.ts check` treats it as clean).
 */
export const requiredPackages = (skillsDir: string): ReadonlyArray<string> => {
	const seen = new Set<string>();
	for (const file of walkFiles(skillsDir)) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const name of extractKampusRefs(text)) seen.add(name);
	}
	return [...seen].sort();
};
