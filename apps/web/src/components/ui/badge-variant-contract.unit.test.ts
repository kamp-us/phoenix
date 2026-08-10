// Manti paints a badge variant as a PAIR — `background: var(--variant-solid); color:
// var(--variant-on-solid)` from the manti.components layer — so a feature class that overrides
// one half leaves the other half's fill underneath. That is how the divan's "incelemede" chip
// rendered muted-grey text on the raw `info` blue (#5228).
import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const sourceRoot = join(import.meta.dirname, "../..");
const badgeElementPattern = /<Badge\b[^>]*>/gs;
const classNamePattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/;

function sourceFiles(directory: string, extension: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) return sourceFiles(path, extension);
		if (!entry.name.endsWith(extension) || entry.name.includes(".test.")) return [];

		return [path];
	});
}

/** Every static `kp-*` class a production `<Badge variant="…">` carries. */
function variantBadgeClasses(): Set<string> {
	const classes = new Set<string>();

	for (const path of sourceFiles(sourceRoot, ".tsx")) {
		for (const element of readFileSync(path, "utf8").matchAll(badgeElementPattern)) {
			if (!/\bvariant=/.test(element[0])) continue;

			const match = classNamePattern.exec(element[0]);
			const value = match?.[1] ?? match?.[2];
			if (!value) continue;

			for (const name of value.split(/\s+/)) {
				if (name.startsWith("kp-")) classes.add(name);
			}
		}
	}

	return classes;
}

type Rule = {file: string; selector: string; body: string};

function cssRules(): Rule[] {
	return sourceFiles(sourceRoot, ".css").flatMap((path) =>
		[...readFileSync(path, "utf8").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
			file: relative(sourceRoot, path),
			selector: (rule[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim(),
			body: rule[2] ?? "",
		})),
	);
}

function declares(body: string, property: RegExp): boolean {
	return property.test(body);
}

/** The rule targets the badge itself only when the class sits in the selector's last compound. */
function targets(selector: string, className: string): boolean {
	return selector
		.split(",")
		.some((part) => part.trim().split(/\s+/).at(-1)?.includes(`.${className}`) === true);
}

describe("Manti badge variant contract", () => {
	const classes = variantBadgeClasses();
	const rules = cssRules();

	it("scans a non-empty set of variant badge classes and CSS rules", () => {
		expect(classes.size).toBeGreaterThan(0);
		expect(rules.length).toBeGreaterThan(0);
	});

	it("overrides a variant's colour pair whole, never half of it", () => {
		const offenders = rules
			.filter((rule) => [...classes].some((name) => targets(rule.selector, name)))
			.filter((rule) => {
				const color = declares(rule.body, /(^|[;{\s])color\s*:/);
				const background = declares(rule.body, /(^|[;{\s])background(-color)?\s*:/);
				return color !== background;
			})
			.map((rule) => `${rule.file} :: ${rule.selector}`);

		expect(offenders).toEqual([]);
	});

	it("renders the incelemede state through ReviewBadge alone", () => {
		const offenders = sourceFiles(sourceRoot, ".tsx")
			.filter((path) => !path.endsWith("ReviewBadge.tsx"))
			.filter((path) => /<Badge\b[\s\S]*?incelemede/.test(readFileSync(path, "utf8")))
			.map((path) => relative(sourceRoot, path));

		expect(offenders).toEqual([]);
	});
});
