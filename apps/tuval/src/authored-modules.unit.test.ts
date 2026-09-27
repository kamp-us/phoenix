/**
 * Which author files a row's code stands on (#9822). The sources here are written the way Node hands
 * them to a `load` hook, and the function texts the way Node's type stripping leaves them: every type
 * a space, every other character where the file has it. `./hot-swap.unit.test.ts` proves the same
 * against Node itself.
 */

import {describe, expect, it} from "vitest";
import {AuthoredModules} from "./authored-modules.ts";

const program = [
	'import {shout} from "./shout.ts";',
	"const restore = (loaded: Partial<Echo> | null): Echo => ({said: loaded?.said ?? ''});",
	"export const init = (loaded: Partial<Echo> | null) => [restore(loaded), []];",
].join("\n");
const shout = "export const shout = (text: string): string => text.toUpperCase();\n";
const other = "export const other = (): number => 1;\n";

/** `init`'s text as Node's type stripping compiles it: the annotation blanked, offsets kept. */
const annotation = ": Partial<Echo> | null";
const initText = `(loaded${" ".repeat(annotation.length)}) => [restore(loaded), []]`;

const modules = (sources: Record<string, string>) =>
	new AuthoredModules(
		new Map(Object.entries(sources)),
		new Map([["/p/program.ts", new Set(["/p/shout.ts"])]]),
	);

describe("AuthoredModules", () => {
	const read = modules({"/p/program.ts": program, "/p/shout.ts": shout, "/p/other.ts": other});

	it("finds the file a type-stripped function was compiled from", () => {
		expect(read.definingFiles(initText)).toEqual(["/p/program.ts"]);
		// A text only close to the file's is not from it.
		expect(read.definingFiles("(loaded) => [restore(loaded), []]")).toEqual([]);
	});

	it("finds no author file behind a package's function", () => {
		expect(read.definingFiles("(value) => value")).toEqual([]);
		expect(read.sourceBehind(["(value) => value"])).toBe("");
		expect(AuthoredModules.none.sourceBehind([initText])).toBe("");
	});

	it("walks what a defining file imports by path, transitively", () => {
		expect(read.closure(read.definingFiles(initText))).toEqual(["/p/program.ts", "/p/shout.ts"]);
	});

	it("moves a row's source when a helper file it stands on is edited, and only then", () => {
		const behind = read.sourceBehind([initText]);
		const helperEdited = modules({
			"/p/program.ts": program,
			"/p/shout.ts": shout.replace("toUpperCase", "toLowerCase"),
			"/p/other.ts": other,
		});
		const otherEdited = modules({
			"/p/program.ts": program,
			"/p/shout.ts": shout,
			"/p/other.ts": other.replace("1", "2"),
		});
		const restoreEdited = modules({
			"/p/program.ts": program.replace("?? ''", "?? 'none'"),
			"/p/shout.ts": shout,
			"/p/other.ts": other,
		});

		expect(
			modules({"/p/program.ts": program, "/p/shout.ts": shout, "/p/other.ts": other}).sourceBehind([
				initText,
			]),
		).toBe(behind);
		expect(helperEdited.sourceBehind([initText])).not.toBe(behind);
		expect(restoreEdited.sourceBehind([initText])).not.toBe(behind);
		expect(otherEdited.sourceBehind([initText])).toBe(behind);
	});
});
