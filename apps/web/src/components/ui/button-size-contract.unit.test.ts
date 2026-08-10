// A feature sheet cannot size a Manti button with bare `width`/`height`: Manti's own
// `[data-scope=button][data-part=root]` sets `min-height: var(--manti-button-height)` and
// Button.css sets `min-width: var(--tap-min)`, so both bare declarations lose and the control
// silently renders at the floor instead of the declared box (#5227).
import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {describe, expect, it} from "vitest";

const sourceRoot = join(import.meta.dirname, "../..");
const buttonElementPattern = /<Button\b[^>]*>/gs;
const classNamePattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/;

function sourceFiles(directory: string, extension: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) return sourceFiles(path, extension);
		if (!entry.name.endsWith(extension) || entry.name.includes(".test.")) return [];

		return [path];
	});
}

/** Every static `kp-*` class a production `<Button>` carries. */
function buttonClasses(): Set<string> {
	const classes = new Set<string>();

	for (const path of sourceFiles(sourceRoot, ".tsx")) {
		for (const element of readFileSync(path, "utf8").matchAll(buttonElementPattern)) {
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

function declares(body: string, property: string): boolean {
	return new RegExp(`(^|[;{\\s])${property}\\s*:`).test(body);
}

/** A fixed px box — the sizing that loses to the contract's floors. `100%`/`auto` is layout. */
function declaresFixedBox(body: string): boolean {
	return /(^|[;{\s])(width|height)\s*:\s*\d+px/.test(body);
}

/** The rule targets the button itself only when the class sits in the selector's last compound. */
function targets(selector: string, className: string): boolean {
	return selector
		.split(",")
		.some((part) => part.trim().split(/\s+/).at(-1)?.includes(`.${className}`) === true);
}

describe("Manti button size contract", () => {
	const classes = buttonClasses();
	const rules = cssRules();

	it("scans a non-empty set of button classes and CSS rules", () => {
		expect(classes.size).toBeGreaterThan(0);
		expect(rules.length).toBeGreaterThan(0);
	});

	it("sizes a button through the size contract, never bare width/height", () => {
		const offenders = rules
			.filter((rule) => [...classes].some((name) => targets(rule.selector, name)))
			.filter((rule) => declaresFixedBox(rule.body))
			.filter(
				(rule) =>
					!declares(rule.body, "min-width") || !declares(rule.body, "--manti-button-height"),
			)
			.map((rule) => `${rule.file} :: ${rule.selector}`);

		expect(offenders).toEqual([]);
	});
});
