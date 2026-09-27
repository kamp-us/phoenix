/**
 * #7559's invariant, re-read since the sub-agent navigator (#8407) could have broken it: the chord
 * reaches the window as a forwarded key, so the list needs no listener of its own and the page keeps
 * the one the desk owns.
 *
 * The page's shell modules live in two roots — the app's `src/shell/` and `@kampus/tuval-ui`'s — so
 * both are walked.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {uiSrc} from "./ui-source.testing.ts";

const appShell = join(import.meta.dirname, "..", "shell");
const uiShell = join(uiSrc, "shell");

const modules = (dir: string): ReadonlyArray<readonly [string, string]> =>
	readdirSync(dir, {recursive: true, withFileTypes: true})
		.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
		.filter((entry) => !entry.name.includes(".test.") && !entry.name.endsWith(".testing.ts"))
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return [path, readFileSync(path, "utf8")] as const;
		});

const keydownOwners = (root: string): ReadonlyArray<string> =>
	modules(root)
		.filter(([, source]) => /addEventListener\(\s*"keydown"/.test(source))
		.map(([path]) => path.slice(root.length + 1));

describe("the page's keyboard listeners", () => {
	it("registers a keydown on a shared target in exactly one module, and it is the desk's", () => {
		expect(keydownOwners(appShell)).toEqual(["ui/Desk.tsx"]);
		expect(keydownOwners(uiShell)).toEqual([]);
	});

	it("walks a package root that holds the chat window, so an empty answer there means something", () => {
		expect(modules(uiShell).some(([path]) => path.endsWith("ChatWindow.tsx"))).toBe(true);
	});
});
