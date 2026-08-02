/**
 * Scripted stand-ins for the two IO seams, so every verb's refusal path is as testable as its
 * answer path — including the ones a real broken tree cannot be asked to produce on demand.
 */
import type {Exec, ExecResult} from "./io/exec.ts";
import type {FileSystemLike} from "./io/fs.ts";

/** A scripted subprocess: match on the joined `file arg arg …` command line. */
export const fakeExec = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	fallback: ExecResult = {ok: false, stdout: "", reason: "unscripted command"},
): Exec => {
	return (file, args) => {
		const line = [file, ...args].join(" ");
		for (const [pattern, result] of script) if (pattern.test(line)) return result;
		return fallback;
	};
};

export const okOut = (stdout: string): ExecResult => ({ok: true, stdout, reason: ""});

export const errOut = (reason: string): ExecResult => ({ok: false, stdout: "", reason});

/** `git ls-tree --name-only` output: one name per line. */
export const tree = (...names: ReadonlyArray<string>): string => names.join("\n");

export interface FakeFsOptions {
	/** Directory path → base names, or `null` to make the directory unreadable. */
	readonly dirs?: Readonly<Record<string, ReadonlyArray<string> | null>>;
	/** File path → contents, or `null` to make the file unreadable. */
	readonly files?: Readonly<Record<string, string | null>>;
	/** Paths whose writes fail. */
	readonly unwritable?: ReadonlyArray<string>;
}

/** An in-memory filesystem that can be told to fail a specific read or write. */
export const fakeFs = (options: FakeFsOptions): FileSystemLike & {written: Map<string, string>} => {
	const dirs = {...options.dirs};
	const files: Record<string, string | null> = {...options.files};
	const written = new Map<string, string>();
	return {
		written,
		readDir: (path) => dirs[path] ?? null,
		readFile: (path) => files[path] ?? null,
		writeFile: (path, text) => {
			if (options.unwritable?.includes(path) === true) return false;
			files[path] = text;
			written.set(path, text);
			return true;
		},
		exists: (path) => Object.hasOwn(files, path) && files[path] !== null,
	};
};

/** A minimal well-formed record. */
export const record = (id: string, status: string, extra = ""): string =>
	`---
id: ${id}
title: A decision about ${id}
status: ${status}
date: 2026-01-01
tags: []
---

# ${id} — A decision about ${id}

## Decision

**Something is decided.** ${extra}
`;
