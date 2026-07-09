import type {LucideIcon} from "lucide-react";
import "./icon.css";

// See ADR 0166 — the one canonical icon idiom. This wrapper pins every functional
// icon to the ruled delivery so call-sites can't drift: drawn Lucide glyphs on the
// 16/20/24 size scale, Lucide's native per-size optical stroke (never a pinned
// absoluteStrokeWidth), and monochrome stroke:currentColor driven by role tokens
// only (icon.css). Pass `label` for a meaningful icon; omit it for a decorative one.
export type IconSize = 16 | 20 | 24;

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
