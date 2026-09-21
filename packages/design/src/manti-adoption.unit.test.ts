import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const sourceRoots = [join(repoRoot, "apps/web/src"), join(repoRoot, "packages/design/src")];
const nativeControlPattern = /<(button|input|select|textarea)\b/;
const rawAlertRolePattern = /\brole\s*=\s*["']alert["']/;
const genericNumberInputPattern = /\btype\s*=\s*["']number["']/;

function productionTsxFiles(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) return productionTsxFiles(path);
		if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];

		return [path];
	});
}

function withoutComments(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

const files = sourceRoots.flatMap((sourceRoot) => productionTsxFiles(sourceRoot));

function offendersMatching(pattern: RegExp, exempt: ReadonlySet<string> = new Set()): string[] {
	return files
		.filter((path) => pattern.test(withoutComments(readFileSync(path, "utf8"))))
		.map((path) => relative(repoRoot, path))
		.filter((path) => !exempt.has(path));
}

// Reconstructing a Manti part is the one shape the native-control rule cannot cover: the dialog's
// close trigger has to carry `data-part="close-trigger"`, and Manti's Button merges its own
// `data-part="root"` last, which overwrites it — measured in Chromium, where the button then lands
// in the flow instead of the dialog's corner. One file, named, and it stays one.
const partReconstruction: ReadonlySet<string> = new Set(["packages/design/src/Dialog.tsx"]);

describe("Manti UI adoption guard", () => {
	// Without this, a directory rename or a changed `import.meta.dirname` base makes
	// the walk return [], every offender list is empty, and all three cases pass having
	// scanned nothing (ADR 0092 — a guard fails closed on zero scope).
	it("scans a non-empty production TSX surface", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("does not render raw interactive form controls in production TSX", () => {
		expect(offendersMatching(nativeControlPattern, partReconstruction)).toEqual([]);
	});

	// An exemption that stops matching is an exemption nobody would notice going stale.
	it("keeps every exempt file an actual offender", () => {
		const raw = offendersMatching(nativeControlPattern);
		expect([...partReconstruction].filter((path) => !raw.includes(path))).toEqual([]);
	});

	it("routes visible alert regions through the Manti Alert primitive", () => {
		expect(offendersMatching(rawAlertRolePattern)).toEqual([]);
	});

	it("uses Manti NumberInput instead of a generic numeric Input", () => {
		expect(offendersMatching(genericNumberInputPattern)).toEqual([]);
	});
});
