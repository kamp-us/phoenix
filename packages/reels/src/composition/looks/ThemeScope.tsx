import type {CSSProperties, ReactNode} from "react";

/**
 * tokens.css declares the role aliases on `:root` only, so a nested `data-theme` re-resolves the
 * raw and semantic layers but not the roles. A scope re-declares the same aliases so they resolve
 * against its own theme; every value still lives in tokens.css.
 */
const ROLES = {
	"--surface": "var(--gray-2)",
	"--surface-sunken": "var(--gray-1)",
	"--surface-raised": "var(--gray-3)",
	"--border-faint": "var(--gray-5)",
	"--border": "var(--gray-6)",
	"--border-strong": "var(--gray-7)",
	"--text-faint": "var(--gray-10)",
	"--text-muted": "var(--gray-11)",
	"--text-secondary": "color-mix(in oklab, var(--gray-11), var(--gray-12))",
	"--text-primary": "var(--gray-12)",
	"--accent": "var(--accent-9)",
	"--accent-soft": "var(--accent-5)",
	"--accent-faint": "var(--accent-3)",
	"--link": "var(--accent-11)",
	"--accent-fg": "var(--accent-contrast)",
} as CSSProperties;

export const ThemeScope = ({
	theme,
	style,
	children,
}: {
	readonly theme: "dark" | "light";
	readonly style?: CSSProperties;
	readonly children: ReactNode;
}) => (
	<div
		data-theme={theme}
		data-color-theme="ember"
		style={{...ROLES, color: "var(--text-primary)", ...style}}
	>
		{children}
	</div>
);
