import {Avatar as BaseAvatar} from "@base-ui/react/avatar";
import {bem} from "../../lib/bem";
import "./Avatar.css";

const styles = bem("kp-avatar", ["image"]);

export type AvatarSize = "sm" | "md" | "lg" | "xl";

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

/**
 * @component Avatar
 * @whenToUse The user/actor image primitive. Always pass `name` — it is the alt
 *   text when `src` renders and the source of the initials fallback when it does
 *   not, so an avatar is never nameless. Reach for it for any actor identity glyph.
 * @slot fallback Rendered when `src` is absent/fails: the first two initials of
 *   `name` (composed internally, not a caller slot).
 */
export function Avatar({
	name,
	src,
	size = "sm",
	className = "",
}: {
	/** Display name — the image `alt` and the source of the initials fallback. */
	name: string;
	/** Image URL; when absent or it fails to load, the initials fallback shows. */
	src?: string;
	/** Rendered size off the scale (`sm` · `md` · `lg` · `xl`). */
	size?: AvatarSize;
	className?: string;
}) {
	const sizeCls = size === "sm" ? "" : `kp-avatar--${size}`;
	return (
		<BaseAvatar.Root className={`${styles.root} ${sizeCls} ${className}`.trim()}>
			{src ? <BaseAvatar.Image src={src} alt={name} className={styles.image} /> : null}
			<BaseAvatar.Fallback>{initialsOf(name)}</BaseAvatar.Fallback>
		</BaseAvatar.Root>
	);
}
