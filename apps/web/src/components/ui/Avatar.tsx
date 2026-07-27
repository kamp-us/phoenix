import {Avatar as MantiAvatar, type AvatarProps as MantiAvatarProps} from "@manti-ui/react";
import "./Avatar.css";

export type AvatarSize = NonNullable<MantiAvatarProps["size"]>;

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

/**
 * @component Avatar
 * @whenToUse The Manti-backed user/actor image primitive. Always pass `name`: it
 *   names the image and supplies the initials fallback when `src` is absent or
 *   fails. Reach for it for any actor identity glyph.
 * @slot fallback Rendered internally from the first two initials of `name`.
 */
export function Avatar({
	name,
	src,
	size = "sm",
	className = "",
}: {
	name: string;
	src?: string;
	size?: AvatarSize;
	className?: string;
}) {
	return (
		<MantiAvatar
			src={src || undefined}
			alt={name}
			size={size}
			shape="square"
			className={`kp-avatar ${className}`.trim()}
		>
			{initialsOf(name)}
		</MantiAvatar>
	);
}
