import type * as React from "react";
import "./atoms.css";

export type TagKind = "discuss" | "ask" | "show" | "rant" | "meta" | "news";

/**
 * @component Tag
 * @whenToUse The category/kind chip — a small colored label for a post kind,
 *   topic, or status. Pass `href` to render it as a link chip, omit it for a
 *   static label. Reach for it over a hand-styled span for any categorical badge.
 * @slot children The chip label.
 */
export function Tag({
	kind = "meta",
	href,
	children,
	className = "",
}: {
	/** Category role driving the chip color (`discuss` · `ask` · `show` · …). */
	kind?: TagKind;
	/** When set, render the chip as a link to this URL. */
	href?: string;
	children: React.ReactNode;
	className?: string;
}) {
	const cls = `kp-tag kp-tag--${kind} ${className}`.trim();
	return href ? (
		<a className={cls} href={href}>
			{children}
		</a>
	) : (
		<span className={cls}>{children}</span>
	);
}

/**
 * @component Kbd
 * @whenToUse The keyboard-key glyph — renders a `<kbd>` for a shortcut key or key
 *   combo mentioned in running text (e.g. a `⌘K` hint). Reach for it over a styled
 *   span so the key reads as a key semantically, not just visually.
 * @slot children The key label (a single key or a combo).
 */
export function Kbd({children}: {children: React.ReactNode}) {
	return <kbd className="kp-kbd">{children}</kbd>;
}

/**
 * @component Mark
 * @whenToUse The highlight glyph — renders a `<mark>` to emphasize a run of text
 *   (a search-match hit, a called-out term). Reach for it over a colored span so
 *   the highlight carries the native highlight semantics.
 * @slot children The highlighted text.
 */
export function Mark({children}: {children: React.ReactNode}) {
	return <mark className="kp-mark">{children}</mark>;
}

/**
 * @component Code
 * @whenToUse The inline-code glyph — renders a `<code>` for an identifier, path, or
 *   short literal inside running prose. Reach for it over a styled span so the code
 *   run is semantic; for a multi-line block use a `<pre>`, not this inline atom.
 * @slot children The code text.
 */
export function Code({children}: {children: React.ReactNode}) {
	return <code className="kp-code">{children}</code>;
}

/**
 * @component Skeleton
 * @whenToUse The loading-placeholder block — a shimmering box that reserves space
 *   for content still in flight. Reach for it to hold layout during a fetch instead
 *   of a spinner or a collapsing void; size it to the content it stands in for.
 * @slot none Presentational; renders no children.
 */
export function Skeleton({
	width,
	height = 12,
	className = "",
}: {
	/** Placeholder width; a bare number is treated as pixels. */
	width?: number | string;
	/** Placeholder height; a bare number is treated as pixels. Defaults to 12. */
	height?: number | string;
	className?: string;
}) {
	return (
		<span
			className={`kp-skeleton ${className}`.trim()}
			style={{
				display: "inline-block",
				width: typeof width === "number" ? `${width}px` : width,
				height: typeof height === "number" ? `${height}px` : height,
			}}
		/>
	);
}
