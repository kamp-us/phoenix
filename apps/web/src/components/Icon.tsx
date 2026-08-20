import type {LucideIcon} from "lucide-react";
import "./icon.css";

// See ADR 0166 — the one canonical icon idiom. Deliberately no `absoluteStrokeWidth`:
// Lucide's native per-size optical stroke is the ruled delivery.

/**
 * See ADR 0240 — 12 and 14 are legal only beside a text label that already carries the
 * meaning; an icon-only control stays at >= 16. This union is the enforcement point.
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
