/**
 * The label on a solid `--danger` fill clears the manifest's 4.5:1 floor for meaning-carrying text
 * in every scheme under every accent (`design-system-manifest.md`, Contrast floors). `--danger` does
 * not vary by accent but the accent's own foreground does, so pairing the fill with `--accent-fg`
 * passed or failed by accent (#9992). The ratios are computed from `tokens.css` itself, resolved the
 * way the cascade resolves them on `<html data-theme data-color-theme>`.
 */
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const here = import.meta.dirname;
const TOKENS = readFileSync(join(here, "tokens.css"), "utf8");
const SCHEMES = ["dark", "light"] as const;
const ACCENTS = [
	"ember",
	"crimson",
	"amber",
	"jade",
	"teal",
	"cyan",
	"indigo",
	"iris",
	"plum",
	"mauve",
] as const;
const FLOOR = 4.5;

type Scheme = (typeof SCHEMES)[number];
type Accent = (typeof ACCENTS)[number];

interface Rule {
	readonly selectors: ReadonlyArray<string>;
	readonly declarations: ReadonlyMap<string, string>;
}

const withoutComments = (css: string): string => css.replaceAll(/\/\*[\s\S]*?\*\//g, "");

function parseRules(css: string): ReadonlyArray<Rule> {
	return [...withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head, body]) => ({
		selectors: (head ?? "").split(",").map((selector) => selector.trim()),
		declarations: new Map(
			[...(body ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
				name as string,
				(value as string).trim(),
			]),
		),
	}));
}

/**
 * Whether a selector matches `<html data-theme={scheme} data-color-theme={accent}>`. Every selector
 * tokens.css uses is `:root` or one attribute selector, so all share specificity and source order
 * decides; any other shape is refused rather than guessed at.
 */
function matches(selector: string, scheme: Scheme, accent: Accent): boolean {
	if (selector === ":root") return true;
	const attribute = /^\[([\w-]+)="([\w-]+)"\]$/.exec(selector);
	if (attribute === null) throw new Error(`unmodelled selector in tokens.css: ${selector}`);
	const [, name, value] = attribute;
	if (name === "data-theme") return value === scheme;
	if (name === "data-color-theme") return value === accent;
	return false;
}

function customProperties(rules: ReadonlyArray<Rule>, scheme: Scheme, accent: Accent) {
	const properties = new Map<string, string>();
	for (const rule of rules) {
		if (!rule.selectors.some((selector) => matches(selector, scheme, accent))) continue;
		for (const [name, value] of rule.declarations) properties.set(name, value);
	}
	return properties;
}

/** The final value of a custom property, and every property its `var()` chain passed through. */
function resolve(
	properties: ReadonlyMap<string, string>,
	name: string,
): {readonly value: string; readonly chain: ReadonlyArray<string>} {
	const chain = [name];
	let value = properties.get(name);
	while (value !== undefined) {
		const reference = /^var\((--[\w-]+)\)$/.exec(value);
		if (reference === null) return {value, chain};
		const next = reference[1] as string;
		chain.push(next);
		value = properties.get(next);
	}
	throw new Error(`${chain.join(" -> ")} does not resolve`);
}

type Rgb = readonly [number, number, number];

const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
const decode = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** Linear-light sRGB of a colour literal: hex, or `oklch()` as tokens.css writes it. */
function linearRgb(color: string): Rgb {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
	if (hex !== null) {
		const digits =
			(hex[1] as string).length === 3
				? [...(hex[1] as string)].map((d) => d + d)
				: (hex[1] as string).match(/../g);
		const [r, g, b] = (digits ?? []).map((pair) => decode(Number.parseInt(pair, 16) / 255));
		return [r as number, g as number, b as number];
	}
	const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color);
	if (oklch === null) throw new Error(`unmodelled colour literal: ${color}`);
	const [lightness, chroma, hue] = oklch.slice(1).map(Number) as [number, number, number];
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

const luminance = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(first: string, second: string): number {
	const [light, dark] = [luminance(linearRgb(first)), luminance(linearRgb(second))].sort(
		(x, y) => y - x,
	) as [number, number];
	return (light + 0.05) / (dark + 0.05);
}

interface Cell {
	readonly scheme: Scheme;
	readonly accent: Accent;
	readonly ratio: number;
	readonly foregroundChain: ReadonlyArray<string>;
}

function dangerCells(css: string): ReadonlyArray<Cell> {
	const rules = parseRules(css);
	return SCHEMES.flatMap((scheme) =>
		ACCENTS.map((accent) => {
			const properties = customProperties(rules, scheme, accent);
			const fill = resolve(properties, "--danger");
			const foreground = resolve(properties, "--danger-fg");
			return {
				scheme,
				accent,
				ratio: contrast(fill.value, foreground.value),
				foregroundChain: foreground.chain,
			};
		}),
	);
}

describe("the label on a solid --danger fill", () => {
	const cells = dangerCells(TOKENS);

	it("is measured in all 20 scheme x accent cells", () => {
		expect(cells).toHaveLength(SCHEMES.length * ACCENTS.length);
	});

	it("clears 4.5:1 in every cell", () => {
		const failing = cells.filter((cell) => cell.ratio < FLOOR);
		expect(
			failing.map(({scheme, accent, ratio}) => `${scheme}/${accent} ${ratio.toFixed(2)}`),
		).toEqual([]);
	});

	it("never derives from the accent's foreground", () => {
		for (const cell of cells) {
			expect(cell.foregroundChain).not.toContain("--accent-fg");
			expect(cell.foregroundChain).not.toContain("--accent-contrast");
		}
	});

	it("would fail on amber if pointed back at --accent-fg", () => {
		const regressed = dangerCells(`${TOKENS}\n:root { --danger-fg: var(--accent-fg); }`);
		const amber = regressed.filter((cell) => cell.accent === "amber");
		expect(amber.some((cell) => cell.ratio < FLOOR)).toBe(true);
	});
});

describe("solid --danger fills in the design package", () => {
	const fills = readdirSync(here)
		.filter((name) => name.endsWith(".css"))
		.flatMap((name) =>
			[...withoutComments(readFileSync(join(here, name), "utf8")).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
				.filter(([, , body]) =>
					/(?:^|[;\s])background(?:-color)?\s*:\s*var\(--danger\)/.test(body ?? ""),
				)
				.map(([, head, body]) => ({
					rule: `${name}: ${(head ?? "").trim()}`,
					color: /(?:^|[;\s])color\s*:\s*([^;]+);/.exec(body ?? "")?.[1]?.trim() ?? null,
				})),
		);

	it("are the button hover and the highlighted menu item", () => {
		expect(fills.map((fill) => fill.rule.split(":")[0])).toEqual(["Button.css", "Menu.css"]);
	});

	it("paint their label with --danger-fg", () => {
		for (const fill of fills)
			expect([fill.rule, fill.color]).toEqual([fill.rule, "var(--danger-fg)"]);
	});
});
