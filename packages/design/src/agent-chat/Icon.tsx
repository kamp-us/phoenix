import type {LucideIcon} from "lucide-react";

export type IconSize = 12 | 14 | 16 | 20 | 24;

export function Icon({
	icon: Glyph,
	size = 20,
	className,
	label,
}: {
	readonly icon: LucideIcon;
	readonly size?: IconSize;
	readonly className?: string;
	readonly label?: string;
}) {
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
