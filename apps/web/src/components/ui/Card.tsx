import type * as React from "react";
import "./Card.css";

/**
 * The composite surface primitive (#2163, pillar cohesiveness; epic #2168). Every
 * page used to hand-assemble its own bordered/tinted box shell — background,
 * border, radius, padding, elevation — as a near-duplicate copy that drifted from
 * the next. `Surface` is the one parameterized shell those copies collapse onto:
 * it emits only role-token classes (no color/spacing/shadow literal lives here),
 * so a shell reads its background from a `tone`, its lift from an `elevation`
 * (the ADR 0162 four-level ramp), and its border/radius/padding from tokens.
 *
 * `Card` is the opinionated default for NEW surfaces — a bordered, subtly-raised,
 * padded box — so a fresh card reaches for one cohesive shape instead of inventing
 * another. A migration that must preserve an existing shell's exact look uses
 * `Surface` with explicit props (moving the shell declarations off the feature CSS
 * and onto props, leaving only the call-site's own layout behind).
 */

/** Background role of the surface — the role token, never a raw scale. */
export type SurfaceTone = "default" | "raised" | "sunken";
/** The ADR 0162 four-level elevation ramp (flat · raised · dropdown · overlay). */
export type Elevation = "flat" | "raised" | "dropdown" | "overlay";
/** Corner radius, off the `--r-*` token scale. */
export type SurfaceRadius = "none" | "sm" | "md" | "lg";
/** Inner padding, off the `--s-*` density scale. */
export type SurfacePadding = "none" | "sm" | "md" | "lg";

export interface SurfaceProps extends React.HTMLAttributes<HTMLElement> {
	/** Render element (article/section/aside/li/…). Defaults to `div`. */
	as?: React.ElementType;
	tone?: SurfaceTone;
	elevation?: Elevation;
	radius?: SurfaceRadius;
	padding?: SurfacePadding;
	/** Draw the 1px role border. */
	border?: boolean;
}

export function Surface({
	as,
	tone = "default",
	elevation = "flat",
	radius = "none",
	padding = "none",
	border = false,
	className = "",
	children,
	...rest
}: SurfaceProps) {
	const Comp = as ?? "div";
	const cls = [
		"kp-surface",
		`kp-surface--tone-${tone}`,
		elevation !== "flat" ? `kp-surface--elev-${elevation}` : "",
		radius !== "none" ? `kp-surface--radius-${radius}` : "",
		padding !== "none" ? `kp-surface--pad-${padding}` : "",
		border ? "kp-surface--border" : "",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<Comp className={cls} {...rest}>
			{children}
		</Comp>
	);
}

export interface CardProps extends SurfaceProps {
	/** Add the hover affordance (background + border shift) for a clickable card. */
	interactive?: boolean;
}

/**
 * @component Card
 * @whenToUse The opinionated default for a NEW surface — a bordered, subtly-raised,
 *   padded box. Reach for `Surface` with explicit props only to preserve an existing
 *   shell's exact look during a migration (the composite-primitive selection rule is
 *   the manifest's, referenced not restated — see `design-system-manifest.md`).
 * @slot children The card's content.
 * @agent Prefer this composite over hand-rolling a bordered box; do not regenerate
 *   this selection guidance — it echoes the manifest's component-selection rule.
 */
export function Card({interactive = false, className = "", ...props}: CardProps) {
	const cls = ["kp-card", interactive ? "kp-card--interactive" : "", className]
		.filter(Boolean)
		.join(" ");
	return (
		<Surface
			tone="default"
			elevation="raised"
			radius="md"
			padding="md"
			border
			className={cls}
			{...props}
		/>
	);
}
