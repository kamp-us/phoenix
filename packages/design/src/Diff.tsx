import {
	getFiletypeFromFileName,
	parseDiffFromFile,
	registerCustomCSSVariableTheme,
} from "@pierre/diffs";
import {FileDiff} from "@pierre/diffs/react";
import {type ReactElement, useMemo} from "react";
import "./Diff.css";
import {useDesignT} from "./i18n";

/**
 * `@pierre/diffs` renders into a Shadow DOM and offers no light-DOM mode: its React `FileDiff`
 * returns a `<diffs-container>` custom element whose constructor calls
 * `attachShadow({mode: "open"})` and adopts the library's own stylesheet
 * (`dist/components/web-components.js` at 1.4.1). So a `tokens.css` rule can never reach the rendered
 * rows, and the only thing that crosses the boundary is an inherited CSS custom property. Every one
 * that does is declared in `Diff.css` on `.kp-diff__pane` — the host element itself, because the
 * library's own `:host` rule beats a value inherited from an ancestor.
 *
 * Two of the library's shapes are deliberately not taken:
 *
 * - **One theme, not a light/dark pair.** The library resolves a pair through CSS `light-dark()`,
 *   which follows the used `color-scheme` rather than phoenix's `data-theme` attribute — the two
 *   disagree the moment an operator picks a theme against their OS. A single Shiki
 *   css-variables theme (`registerCustomCSSVariableTheme`) emits `var(--diffs-…)` for every colour
 *   instead, so light and dark come from the role tokens, which already switch on `data-theme`.
 *   The library's own stylesheet still calls `light-dark()` for things no property overrides — the
 *   row-tint ratios — so `Diff.css` also pins `color-scheme` off `data-theme`, dark unless an
 *   explicit `[data-theme="light"]` ancestor says otherwise, which is the token set's own default.
 * - **`overflow: "wrap"`, not the default scroll.** The default puts the horizontal scroller inside
 *   the shadow root, where no tab stop can be placed on it (WCAG 2.1.1). Wrapping removes that
 *   scroller, which leaves the block below as the one that scrolls and the one that carries the tab
 *   stop — `CodeBlock`'s rule, that the element that scrolls is the element that is focusable.
 */
const THEME = "kampus-role-tokens";

let themeRegistered = false;

/**
 * Registered on the first render rather than at import. A top-level call here is a module side
 * effect, and a side effect is what stops a bundler dropping an unused module — it put 15 KB of
 * Shiki's theme registry into the desk bundle for a component the desk never rendered.
 */
function ensureTheme(): void {
	if (themeRegistered) return;
	registerCustomCSSVariableTheme(THEME, {});
	themeRegistered = true;
}

export interface DiffProps {
	/** The text before the change. Empty means an added file. */
	readonly before: string;
	/** The text after the change. Empty means a deleted file. */
	readonly after: string;
	/** The file's path — it names the diff and its extension picks the language. */
	readonly path: string;
	/** Old and new side by side. Unified (one column) is the default. */
	readonly split?: boolean;
}

export function Diff({before, after, path, split = false}: DiffProps): ReactElement {
	const t = useDesignT();
	ensureTheme();
	const fileDiff = useMemo(() => {
		const lang = getFiletypeFromFileName(path);
		return parseDiffFromFile(
			{name: path, contents: before, lang},
			{name: path, contents: after, lang},
		);
	}, [before, after, path]);

	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the tab stop is the point — see the docblock above.
		// biome-ignore lint/a11y/useSemanticElements: a `<section>` would not be the box that scrolls.
		<div className="kp-diff" tabIndex={0} role="region" aria-label={t("ui.diff", {path})}>
			<FileDiff
				className="kp-diff__pane"
				fileDiff={fileDiff}
				options={{diffStyle: split ? "split" : "unified", overflow: "wrap", theme: THEME}}
			/>
		</div>
	);
}
