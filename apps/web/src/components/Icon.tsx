import type {LucideIcon} from "lucide-react";
import "./icon.css";

// See ADR 0166 — the one canonical icon idiom. This wrapper pins every functional
// icon to the ruled delivery so call-sites can't drift: drawn Lucide glyphs on the
// ruled size scale, Lucide's native per-size optical stroke (never a pinned
// absoluteStrokeWidth), and monochrome stroke:currentColor driven by role tokens
// only (icon.css). Pass `label` for a meaningful icon; omit it for a decorative one.

/**
 * 12 and 14 are the dense tier ADR 0240 added to 0166's 16/20/24, and they are legal ONLY
 * beside a text label that already carries the meaning — the topbar's 24px-tall search box,
 * an --t-meta back link. An icon that is the only thing saying what it means, and any
 * icon-only control, stays at >= 16 where the stroke is unambiguous on a dark ground.
 * This union is the enforcement point: a size off the scale is a type error.
 */
export type IconSize = 12 | 14 | 16 | 20 | 24;

export interface IconProps {
	icon: LucideIcon;
	size?: IconSize;
	className?: string;
	label?: string;
}

export function Icon({icon: Glyph, size = 20, className, label}: IconProps) {
	return (
		<Glyph
			className={className ? `kp-icon ${className}` : "kp-icon"}
			size={size}
			aria-hidden={label ? undefined : true}
			aria-label={label}
			role={label ? "img" : undefined}
		/>
	);
}
