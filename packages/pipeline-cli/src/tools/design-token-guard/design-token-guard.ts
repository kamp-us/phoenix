/**
 * `design-token-guard` pure core (issue #2170, ADR 0162 / design-system-manifest.md)
 * — the first deterministic enforcement rung of the four-pillars design law. Decides,
 * over already-gathered CSS facts, whether the design-token seam holds:
 *
 *   1. undefined-ref — every `var(--…)` in a component CSS file resolves to a custom
 *      property declared somewhere in the CSS corpus (tokens.css role layer,
 *      global.css focus tokens, or a component-local `--x:`), a runtime-injected
 *      property (config `externalProperties`), or a grandfathered dead ref
 *      (`grandfatheredMissingTokens`). A ref to none of those FAILS. This is exactly
 *      the Toast `var(--surface-1)`/`var(--text)` dead-ref class (#2167).
 *   2. raw-hex — a component CSS file (anything but the raw-scale layer `tokens.css`)
 *      carries no hex color literal. Hex lives ONLY in tokens.css by law
 *      (design-system-manifest.md Pillar 2) — a component reaches for a role token.
 *   3. raw-px ratchet — a component CSS file's count of raw `px` values > 2px (the
 *      4px grid sanctions 1px & 2px for hairlines/nudges, ADR 0162 value #1) does not
 *      exceed its per-file ceiling in `rawPxCeilings`. A file over ceiling FAILS
 *      (regression / new debt); a file with no ceiling entry must be raw-px clean.
 *
 * IO-free and total: every decision is a deterministic transform over facts gathered
 * at the filesystem boundary (`gate.ts`); this module never touches disk. Fail-closed
 * on zero scope (ADR 0092): zero CSS files discovered is a broken scope assumption, a
 * wrong root, not a vacuous pass.
 *
 * The allow-lists are bounded and documented in
 * `apps/web/src/styles/design-token-lint.config.json`; they grandfather the
 * pre-existing debt the frontend audit catalogued so the gate is green on `main`
 * while still failing on any NEW bypass — see the guard README for the model.
 */

/** The three bounded allow-lists, read from the app-side config JSON. */
export interface DesignTokenConfig {
	/** Runtime-injected custom properties a `var(--…)` may resolve to (no CSS declaration). */
	readonly externalProperties: ReadonlyArray<string>;
	/** Pre-existing dead refs, grandfathered by name pending remediation (#2163/#2166). */
	readonly grandfatheredMissingTokens: ReadonlyArray<string>;
	/** Per-file ceiling on raw `px` > 2px values (repo-relative path → max count). */
	readonly rawPxCeilings: Readonly<Record<string, number>>;
}

/** One `var(--name)` reference discovered in a CSS file. */
export interface VarRef {
	readonly name: string;
	readonly line: number;
}

/** One raw literal (hex color or `px` value) discovered in a CSS file. */
export interface RawLiteral {
	readonly value: string;
	readonly line: number;
}

/** The gathered facts for one CSS file (all parsed at the IO boundary). */
export interface CssFileFacts {
	/** Repo-relative path (POSIX separators), the key the ceilings map uses. */
	readonly path: string;
	/** The raw-scale layer (`tokens.css`) — the one file exempt from the hex/px checks. */
	readonly isRawLayer: boolean;
	/** Custom properties this file declares (`--x:`). */
	readonly declared: ReadonlyArray<string>;
	/** `var(--…)` references this file makes. */
	readonly varRefs: ReadonlyArray<VarRef>;
	/** Hex color literals this file carries (comments already stripped). */
	readonly hexLiterals: ReadonlyArray<RawLiteral>;
	/** Raw `px` values > 2px this file carries (comments + at-rule lines already stripped). */
	readonly rawPx: ReadonlyArray<RawLiteral>;
}

export interface DesignTokenGuardFacts {
	readonly files: ReadonlyArray<CssFileFacts>;
	readonly config: DesignTokenConfig;
}

/** An undefined-ref failure: a `var(--…)` that resolves to nothing. */
export interface UndefinedRefFailure {
	readonly path: string;
	readonly name: string;
	readonly line: number;
}

/** A raw-hex failure: a hex color literal outside the raw-scale layer. */
export interface HexFailure {
	readonly path: string;
	readonly value: string;
	readonly line: number;
}

/** A raw-px failure: a file whose raw-px count exceeds (or lacks) its ceiling. */
export interface RawPxFailure {
	readonly path: string;
	readonly count: number;
	/** The ceiling this file was allowed; `null` when the file has no ceiling entry. */
	readonly ceiling: number | null;
	/** A few example sites (up to 3) to make the report actionable. */
	readonly samples: ReadonlyArray<RawLiteral>;
}

export type DesignTokenGuardVerdict =
	| {
			readonly pass: true;
			readonly filesChecked: number;
			readonly varRefsChecked: number;
	  }
	/** No CSS files discovered — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	| {
			readonly pass: false;
			readonly reason: "violations";
			readonly undefinedRefs: ReadonlyArray<UndefinedRefFailure>;
			readonly hex: ReadonlyArray<HexFailure>;
			readonly rawPx: ReadonlyArray<RawPxFailure>;
	  };

/**
 * Decide the verdict over the gathered facts. Order: fail-closed on zero scope, then
 * gather all three violation classes and fail if any is non-empty. The three checks
 * are independent (a file can have several classes at once); the report lists them all
 * so one CI run surfaces every seam break.
 */
export const judge = (facts: DesignTokenGuardFacts): DesignTokenGuardVerdict => {
	const {files, config} = facts;

	if (files.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}

	// The universe a var(--…) may resolve to: every declared property across the whole
	// CSS corpus (cascade is corpus-wide, not per-file), plus runtime-injected and
	// grandfathered names. A ref outside it is a dead ref.
	const declaredUniverse = new Set<string>();
	for (const f of files) for (const d of f.declared) declaredUniverse.add(d);
	for (const e of config.externalProperties) declaredUniverse.add(e);
	for (const g of config.grandfatheredMissingTokens) declaredUniverse.add(g);

	const undefinedRefs: Array<UndefinedRefFailure> = [];
	const hex: Array<HexFailure> = [];
	const rawPx: Array<RawPxFailure> = [];
	let varRefsChecked = 0;

	for (const f of files) {
		for (const ref of f.varRefs) {
			varRefsChecked++;
			if (!declaredUniverse.has(ref.name)) {
				undefinedRefs.push({path: f.path, name: ref.name, line: ref.line});
			}
		}

		// The raw-scale layer (tokens.css) is where hex + raw px legitimately live.
		if (f.isRawLayer) continue;

		for (const h of f.hexLiterals) {
			hex.push({path: f.path, value: h.value, line: h.line});
		}

		const count = f.rawPx.length;
		const ceiling = config.rawPxCeilings[f.path] ?? null;
		if (count > (ceiling ?? 0)) {
			rawPx.push({path: f.path, count, ceiling, samples: f.rawPx.slice(0, 3)});
		}
	}

	undefinedRefs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	hex.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	rawPx.sort((a, b) => a.path.localeCompare(b.path));

	if (undefinedRefs.length > 0 || hex.length > 0 || rawPx.length > 0) {
		return {pass: false, reason: "violations", undefinedRefs, hex, rawPx};
	}

	return {pass: true, filesChecked: files.length, varRefsChecked};
};

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: DesignTokenGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`design-token-guard: ${verdict.filesChecked} CSS files, ${verdict.varRefsChecked} ` +
			"var(--…) refs — every ref resolves, no raw hex outside tokens.css, no raw-px regression"
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			"design-token-guard: discovered ZERO CSS files under apps/web/src — fail-closed " +
			"(ADR 0092). Is the repo root correct, or did the styles layout change?"
		);
	}

	const sections: Array<string> = [];

	if (verdict.undefinedRefs.length > 0) {
		const lines = verdict.undefinedRefs.map((r) => `    ${r.path}:${r.line}  var(${r.name})`);
		sections.push(
			`  UNDEFINED TOKEN REF (${verdict.undefinedRefs.length}) — a var(--…) that resolves to ` +
				"no declared, runtime-injected, or grandfathered property (the Toast dead-ref class, " +
				"#2167). Reach for an existing role token (design-system-manifest.md), or — if it is " +
				"genuinely runtime-injected — add it to externalProperties in " +
				"apps/web/src/styles/design-token-lint.config.json:\n" +
				lines.join("\n"),
		);
	}

	if (verdict.hex.length > 0) {
		const lines = verdict.hex.map((h) => `    ${h.path}:${h.line}  ${h.value}`);
		sections.push(
			`  RAW HEX OUTSIDE tokens.css (${verdict.hex.length}) — hex color literals live ONLY in ` +
				"the raw-scale layer (apps/web/src/styles/tokens.css) by law " +
				"(design-system-manifest.md, Pillar 2). Reach for a role token (--surface, --text-*, " +
				"--accent, --link, …):\n" +
				lines.join("\n"),
		);
	}

	if (verdict.rawPx.length > 0) {
		const lines = verdict.rawPx.map((p) => {
			const where = p.ceiling === null ? "no ceiling (must be 0)" : `ceiling ${p.ceiling}`;
			const eg = p.samples.map((s) => `${s.value}@L${s.line}`).join(", ");
			return `    ${p.path}  ${p.count} raw px > 2px, ${where}  e.g. ${eg}`;
		});
		sections.push(
			`  RAW-PX REGRESSION (${verdict.rawPx.length} file${verdict.rawPx.length === 1 ? "" : "s"}) — ` +
				"a raw px > 2px bypasses the 4px spacing seam (the grid sanctions only 1px & 2px, ADR " +
				"0162 value #1). Reach for a --s-N spacing token, or land the change under the file's " +
				"existing ceiling. After a genuine cleanup leg, regenerate the ceilings with " +
				"`pipeline-cli design-token-guard check --write-baseline`:\n" +
				lines.join("\n"),
		);
	}

	return (
		"design-token-guard: the design-token seam is broken (issue #2170, ADR 0162):\n" +
		`${sections.join("\n\n")}\n\n` +
		"The four-pillars design law (design-system-manifest.md) requires role tokens only — no " +
		"raw hex, no raw-px bypass of the spacing ramp, and no ref to a token that does not exist."
	);
};

// ── Pure text parsers ─────────────────────────────────────────────────────────
// Pure over CSS source text so the gate can gather facts without a CSS parser
// dependency and the parsers are unit-testable in isolation (the fanout-guard idiom).

/** Strip `/* … *​/` block comments (CSS has no line comments). Keeps line count stable. */
export const stripCssComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const lineOf = (src: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
	return line;
};

/**
 * Custom properties declared in `src` (`--name:` in a declaration position). The
 * preceding-char guard (`start | whitespace | ; | {`) excludes a `var(--name)`
 * reference — whose `--name` is preceded by `(` — from being read as a declaration.
 */
export const parseDeclaredProperties = (src: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	const re = /(?:^|[\s;{])(--[a-zA-Z0-9-]+)\s*:/gm;
	for (const m of stripCssComments(src).matchAll(re)) {
		if (m[1] !== undefined) out.push(m[1]);
	}
	return out;
};

/** `var(--…)` references in `src`, with 1-based line numbers (comments stripped). */
export const parseVarReferences = (src: string): ReadonlyArray<VarRef> => {
	const stripped = stripCssComments(src);
	const out: Array<VarRef> = [];
	const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
	for (const m of stripped.matchAll(re)) {
		if (m[1] !== undefined && m.index !== undefined) {
			out.push({name: m[1], line: lineOf(stripped, m.index)});
		}
	}
	return out;
};

/** Hex color literals (#rgb / #rgba / #rrggbb / #rrggbbaa) in `src` (comments stripped). */
export const parseHexLiterals = (src: string): ReadonlyArray<RawLiteral> => {
	const stripped = stripCssComments(src);
	const out: Array<RawLiteral> = [];
	const re = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
	for (const m of stripped.matchAll(re)) {
		if (m.index !== undefined) out.push({value: m[0], line: lineOf(stripped, m.index)});
	}
	return out;
};

const AT_RULE_RE = /@media|@container|@supports/;

/**
 * Raw `px` values > 2px in `src` (comments stripped; at-rule lines — where px is a
 * legit breakpoint — skipped). The negative lookbehind excludes a `px` that is part of
 * an identifier/hex; `1px` and `2px` are the sanctioned grid exceptions (ADR 0162
 * value #1) and are not returned.
 */
export const parseRawPxOverTwo = (src: string): ReadonlyArray<RawLiteral> => {
	const stripped = stripCssComments(src);
	const lines = stripped.split("\n");
	const out: Array<RawLiteral> = [];
	const re = /(?<![-\w.#])(\d+(?:\.\d+)?)px\b/g;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (AT_RULE_RE.test(line)) continue;
		for (const m of line.matchAll(re)) {
			const value = Number.parseFloat(m[1] ?? "0");
			if (value > 2) out.push({value: `${m[1]}px`, line: i + 1});
		}
	}
	return out;
};
