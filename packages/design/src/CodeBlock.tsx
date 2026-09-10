import type {Tokens} from "marked";
import type {ReactElement} from "react";
import {useDesignT} from "./i18n";

/**
 * `pre code` is `white-space: pre`, so a long line makes the fence a horizontal scroller (see
 * `Markdown.css`) — and a scroll container no keyboard can focus is content a keyboard-only
 * operator cannot read at all (WCAG 2.1.1), the same hazard `Markdown`'s table wrapper answers. The
 * tab stop sits on the `<pre>` itself rather than on a wrapper because the `<pre>` *is* the
 * scroller, and arrow keys scroll the focused element only. Unlike `<table>`, `<pre>` carries no
 * implicit role that `role="region"` costs.
 *
 * It lives apart from `Markdown` because `MermaidBlock` renders it too — as the first paint a
 * diagram replaces, and as the fallback a fence mermaid cannot parse stays on.
 */
export function CodeBlock({token}: {readonly token: Tokens.Code}): ReactElement {
	const t = useDesignT();
	const lang = token.lang === undefined || token.lang === "" ? undefined : token.lang;
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the tab stop is the point — see the docblock above.
		// biome-ignore lint/a11y/useSemanticElements: a `<section>` wrapper would take the tab stop off the box that actually scrolls — see the docblock above.
		<pre tabIndex={0} role="region" aria-label={t("ui.markdown.code")}>
			<code className={lang === undefined ? undefined : `language-${lang}`}>{token.text}</code>
		</pre>
	);
}
