import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const sourceRoot = join(import.meta.dirname, "../..");
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

describe("Manti UI adoption guard", () => {
	it("does not render raw interactive form controls in production TSX", () => {
		const offenders = productionTsxFiles(sourceRoot)
			.filter((path) => nativeControlPattern.test(withoutComments(readFileSync(path, "utf8"))))
			.map((path) => relative(sourceRoot, path));

		expect(offenders).toEqual([]);
	});

	it("routes visible alert regions through the Manti Alert primitive", () => {
		const offenders = productionTsxFiles(sourceRoot)
			.filter((path) => rawAlertRolePattern.test(withoutComments(readFileSync(path, "utf8"))))
			.map((path) => relative(sourceRoot, path));

		expect(offenders).toEqual([]);
	});

	it("uses Manti NumberInput instead of a generic numeric Input", () => {
		const offenders = productionTsxFiles(sourceRoot)
			.filter((path) => genericNumberInputPattern.test(withoutComments(readFileSync(path, "utf8"))))
			.map((path) => relative(sourceRoot, path));

		expect(offenders).toEqual([]);
	});
});
