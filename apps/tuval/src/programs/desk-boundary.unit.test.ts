/**
 * The boundary this child keeps: it **consumes** the desk mechanism of #7691 and rebuilds none of
 * it. A program owns the inside of the inspector and the middle of the bar, and it owns nothing
 * else — not the region, not the key that toggles it, not the bar.
 *
 * The proof is textual because that is what the claim is about: a file that imports the desk's own
 * state, the shell's status line, or the splitter the region is built from is a file that has
 * started to own a surface, and so is one that attaches a key listener. Reading the source is the
 * only way to see that, and the list is enumerated rather than globbed so a file added later must
 * be added here deliberately.
 */

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const dir = import.meta.dirname;

/** Every file this child adds or extends on the desk-renderer path. */
const files: ReadonlyArray<string> = [
	"desk-renderers/detail.ts",
	"desk-renderers/segments.ts",
	"desk-renderers/selection.ts",
	"desk-renderers/index.ts",
	"desk-renderers/ProcessDetailView.tsx",
	"engine-view/status.ts",
	"engine-view/ui/inspector.tsx",
	"ps/status.ts",
	"ps/inspector.tsx",
];

const sourceOf = (name: string): string => readFileSync(join(dir, name), "utf8");

const specifiersIn = (source: string): ReadonlyArray<string> =>
	[...source.matchAll(/from\s+"([^"]+)"|import\s+"([^"]+)"/g)].map(
		(match) => match[1] ?? match[2] ?? "",
	);

describe("desk-renderer boundary", () => {
	it("owns no desk state: nothing reaches the inspector's open flag or its toggle", () => {
		const offenders = files.filter((name) => {
			const source = sourceOf(name);
			return (
				specifiersIn(source).some((specifier) => /shell\/desk\/state/.test(specifier)) ||
				/\b(toggleInspector|initialDesk|DeskState|DeskMsg)\b/.test(source)
			);
		});
		expect(offenders).toEqual([]);
	});

	it("builds no status bar: nothing composes one or reaches the shell's own line", () => {
		const offenders = files.filter((name) => {
			const source = sourceOf(name);
			return (
				specifiersIn(source).some((specifier) =>
					/shell\/ui\/StatusLine|shell\/ui\/frame|shell\/desk\/compose/.test(specifier),
				) || /\b(statusFor|inspectorFor|StatusBar|statusFrame)\b/.test(source)
			);
		});
		expect(offenders).toEqual([]);
	});

	it("builds no region and binds no key", () => {
		const offenders = files.filter((name) => {
			const source = sourceOf(name);
			return (
				specifiersIn(source).some((specifier) =>
					/react-resizable-panels|shell\/keys|shell\/ui\/Desk/.test(specifier),
				) || /addEventListener|onKeyDown|PrefixTable/.test(source)
			);
		});
		expect(offenders).toEqual([]);
	});

	it("reads no second source of process facts, and no socket", () => {
		const forbidden = [
			/^node:/,
			/^ws$/,
			/\/process\/process/,
			/table\/ProcessTablePort/,
			/shell\/transport\//,
		];
		const offenders = files.flatMap((name) =>
			specifiersIn(sourceOf(name))
				.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("the probe is not vacuous: this test file itself trips every rule it enforces", () => {
		const self = sourceOf("desk-boundary.unit.test.ts");
		expect(/\b(toggleInspector|DeskState)\b/.test(self)).toBe(true);
		expect(/\b(statusFor|StatusBar)\b/.test(self)).toBe(true);
		expect(/addEventListener/.test(self)).toBe(true);
		expect(specifiersIn(self).some((specifier) => /^node:/.test(specifier))).toBe(true);
	});
});
