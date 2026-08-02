/**
 * The filesystem seam — plain node, no `effect` import, injectable so a verb's unreadable-input
 * path is testable without a real broken directory.
 *
 * Every reader returns `null` for "I could not read this", never an empty value. An unreadable
 * directory that came back as `[]` would be indistinguishable from a directory that is genuinely
 * empty, and the two take opposite branches: one is a refusal, the other (for `adr new`) is fine.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";

export interface FileSystemLike {
	/** Base names in `path`, or `null` when the directory could not be read. */
	readDir(path: string): ReadonlyArray<string> | null;
	/** The file's UTF-8 text, or `null` when it could not be read. */
	readFile(path: string): string | null;
	/** `true` on a successful write. */
	writeFile(path: string, text: string): boolean;
	exists(path: string): boolean;
}

export const nodeFileSystem: FileSystemLike = {
	readDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return null;
		}
	},
	readFile: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	writeFile: (path, text) => {
		try {
			mkdirSync(dirname(path), {recursive: true});
			writeFileSync(path, text, "utf8");
			return true;
		} catch {
			return false;
		}
	},
	exists: (path) => existsSync(path),
};
