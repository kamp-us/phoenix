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

export function Kbd({children}: {children: React.ReactNode}) {
	return <kbd className="kp-kbd">{children}</kbd>;
}

export function Mark({children}: {children: React.ReactNode}) {
	return <mark className="kp-mark">{children}</mark>;
}

export function Code({children}: {children: React.ReactNode}) {
	return <code className="kp-code">{children}</code>;
}

export function Skeleton({
	width,
	height = 12,
	className = "",
}: {
	width?: number | string;
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
