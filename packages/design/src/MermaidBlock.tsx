/**
 * `MermaidBlock` — a ```mermaid fence rendered as a diagram, wherever `Markdown` renders (#8128,
 * founder ruling 2026-09-05: "i am ok with supporting mermaid everywhere we support markdown").
 *
 * Three things here are not obvious from the code.
 *
 * **The fence paints first and the diagram replaces it.** `Markdown` promises everything paints on
 * the first render, because a transcript row is measured after paint. Mermaid's layout is async
 * and its module is a megabyte, so the honest first paint is the fence itself — the row measures a
 * real height, and when the SVG lands the row's border box changes and the virtualizer's own
 * `ResizeObserver` re-measures it (`@tanstack/virtual-core@3.17.8`: `Virtualizer.measureElement`
 * calls `this.observer.observe(node)` on every row node, and the observer callback runs
 * `resizeItem`). The same swap is what keeps a bad fence readable: it never leaves the source.
 *
 * **The SVG arrives as a string, so this block alone reacquires the `innerHTML` seam the rest of
 * `Markdown` was shaped to avoid.** Mermaid's own DOMPurify pass is what closes it: at any
 * `securityLevel` but `loose`, `render`'s `serializeSvg` returns `DOMPurify.sanitize(code, …)`
 * (`mermaid@11.17.2`, `dist/mermaid.core.mjs`). `strict` is passed explicitly rather than left to
 * the default so that stays a decision this file made and a reader can find.
 *
 * **`mermaid.initialize` is global, so the theme is the last block's.** Every block on a page
 * resolves the same tokens off its own host, so the values agree — unless two hosts sit under
 * different `[data-theme]` roots, and then a diagram can paint in its sibling's scheme. No surface
 * does that today.
 */

import type {Tokens} from "marked";
import {type ReactElement, useEffect, useId, useRef, useState} from "react";
import {CodeBlock} from "./CodeBlock";
import {useDesignT} from "./i18n";

/**
 * Design token per mermaid theme variable. Mermaid's `base` theme derives every variable it is not
 * given, so this list is exactly what a diagram paints with rather than a palette beside one.
 *
 * **No stroke here may come off the `--border-*` ladder.** Those roles are chrome — a divider
 * against a surface the eye is not asked to read — and none of them clears the manifest's 3:1
 * floor for meaning-carrying non-text against the container this diagram paints on
 * (`--border-strong` is 1.35:1 light / 2.06:1 dark on `--surface-sunken`). In a diagram every
 * stroke IS the content: an edge is which node points at which, and a node's outline is the only
 * thing delineating the box, because `--surface-raised` on `--surface-sunken` is 1.09:1. So the
 * strokes come off the text ladder, which is where the floors live — `--text-muted` for the
 * strokes that carry meaning, `--text-faint` for the grouping outlines (cluster, note, the
 * secondary/tertiary node classes), which still clears 3:1 while keeping a weight step below.
 * Ratios per scheme are in #8319's body.
 */
const THEME_TOKENS = {
	background: "--surface",
	mainBkg: "--surface-raised",
	primaryColor: "--surface-raised",
	primaryTextColor: "--text-primary",
	primaryBorderColor: "--text-muted",
	secondaryColor: "--surface-sunken",
	secondaryTextColor: "--text-secondary",
	secondaryBorderColor: "--text-faint",
	tertiaryColor: "--surface",
	tertiaryTextColor: "--text-secondary",
	tertiaryBorderColor: "--text-faint",
	nodeBorder: "--text-muted",
	nodeTextColor: "--text-primary",
	clusterBkg: "--surface-sunken",
	clusterBorder: "--text-faint",
	lineColor: "--text-muted",
	textColor: "--text-primary",
	titleColor: "--text-primary",
	edgeLabelBackground: "--surface",
	labelBoxBkgColor: "--surface-raised",
	labelBoxBorderColor: "--text-muted",
	labelTextColor: "--text-primary",
	noteBkgColor: "--surface-raised",
	noteBorderColor: "--text-faint",
	noteTextColor: "--text-secondary",
	actorBkg: "--surface-raised",
	actorBorder: "--text-muted",
	actorTextColor: "--text-primary",
	signalColor: "--text-muted",
	signalTextColor: "--text-primary",
	errorBkgColor: "--surface-raised",
	errorTextColor: "--danger",
} as const;

const channel = (value: number): string => value.toString(16).padStart(2, "0");

/**
 * Reads a CSS colour the engine has already computed and hands back the sRGB hex khroma — mermaid's
 * colour library — can parse. A colour the engine serialized in its authored space (`oklch(…)`,
 * this repo's) is the whole reason: khroma reads hex, `rgb()` and `hsl()` and nothing else. A 1×1
 * canvas fill converts it, because `getImageData` is defined to return 8-bit sRGB whatever was
 * filled — so a canvas is only built once a colour that needs one turns up, which is also what
 * keeps a canvas-less environment quiet.
 */
function srgbHex(colour: string, paint: () => CanvasRenderingContext2D | null): string | null {
	if (/^(#|rgba?\(|hsla?\()/.test(colour)) return colour;
	const context = paint();
	if (context === null) return null;
	context.fillStyle = colour;
	context.clearRect(0, 0, 1, 1);
	context.fillRect(0, 0, 1, 1);
	const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
	if (red === undefined || green === undefined || blue === undefined) return null;
	return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/**
 * The design tokens, resolved against this block's own host.
 *
 * The probe earns its place: a custom property's computed value is its specified value with `var()`
 * substituted and *nothing else evaluated* (CSS Custom Properties Level 1, §3), so
 * `--text-secondary` reads straight back as the literal text `color-mix(in oklab, …)`. Assigning it
 * to a real `color` is what makes the engine evaluate it.
 *
 * `null` means no token resolved at all — no stylesheet loaded, as under jsdom, where a `var()` the
 * cascade never resolved reads back as the literal text `var(--surface)`. Then mermaid keeps its
 * own defaults rather than painting a half-themed diagram.
 */
function tokenPalette(host: HTMLElement): Readonly<Record<string, string>> | null {
	const probe = document.createElement("span");
	probe.style.display = "none";
	host.appendChild(probe);

	let context: CanvasRenderingContext2D | null | undefined;
	const paint = (): CanvasRenderingContext2D | null => {
		if (context === undefined) {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			context = canvas.getContext("2d", {willReadFrequently: true});
		}
		return context;
	};

	try {
		const entries = Object.entries(THEME_TOKENS).flatMap(([variable, token]) => {
			probe.style.color = `var(${token})`;
			const resolved = getComputedStyle(probe).color;
			if (resolved === "" || resolved.includes("var(")) return [];
			const hex = srgbHex(resolved, paint);
			return hex === null ? [] : [[variable, hex] as const];
		});
		return entries.length === 0 ? null : Object.fromEntries(entries);
	} catch {
		return null;
	} finally {
		probe.remove();
	}
}

type Diagram =
	| {readonly kind: "source"}
	| {readonly kind: "drawn"; readonly svg: string}
	| {readonly kind: "failed"; readonly reason: string};

const reasonOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export function MermaidBlock({token}: {readonly token: Tokens.Code}): ReactElement {
	const t = useDesignT();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [diagram, setDiagram] = useState<Diagram>({kind: "source"});
	// Mermaid names the SVG it builds with this id and selects it back by it, so it has to be one
	// element's alone; React's own `useId` carries `:`, which no CSS selector accepts.
	const id = `kp-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const source = token.text;

	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let live = true;
		void (async () => {
			try {
				const {default: mermaid} = await import("mermaid");
				const palette = tokenPalette(host);
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					// Without this, a source that passes `parse` but throws in the draw step leaves
					// mermaid's own error diagram in the temp div it appended to `document.body` and
					// never removes (`mermaid@11.17.2`, `dist/mermaid.core.mjs`, the `catch` after
					// `diag.renderer.draw`) — a stray SVG outside the row, beside this block's fallback.
					suppressErrorRendering: true,
					theme: "base",
					// The token set defaults to dark and light is the opt-in (`tokens.css`), so the
					// nearest opted-in ancestor is the whole question. Mermaid derives contrast for
					// anything the palette below leaves unset, and this is what it derives against.
					darkMode: host.closest('[data-theme="light"]') === null,
					...(palette === null ? {} : {themeVariables: palette}),
				});
				await mermaid.parse(source);
				const {svg} = await mermaid.render(id, source);
				if (live) setDiagram({kind: "drawn", svg});
			} catch (error) {
				if (live) setDiagram({kind: "failed", reason: reasonOf(error)});
			}
		})();
		return () => {
			live = false;
		};
	}, [source, id]);

	return (
		<div className="kp-markdown__diagram" ref={hostRef}>
			{diagram.kind === "drawn" ? (
				<>
					{/* The one `innerHTML` in this package. Mermaid's own DOMPurify pass is the sanitizer
					    that makes it safe, and the module docblock cites where it runs. */}
					<div
						className="kp-markdown__diagram-svg"
						role="img"
						aria-label={t("ui.markdown.diagram")}
						dangerouslySetInnerHTML={{__html: diagram.svg}}
					/>
					{/* `role="img"` makes the SVG's own text presentational, so the source is the only
					    reading of the diagram assistive tech gets — it is a disclosure, not a hidden note,
					    so a sighted operator can read it too. */}
					<details className="kp-markdown__diagram-source">
						<summary>{t("ui.markdown.diagram.source")}</summary>
						<CodeBlock token={token} />
					</details>
				</>
			) : (
				<>
					{diagram.kind === "failed" ? (
						<p className="kp-markdown__diagram-error">
							{t("ui.markdown.diagram.error", {reason: diagram.reason})}
						</p>
					) : null}
					<CodeBlock token={token} />
				</>
			)}
		</div>
	);
}
