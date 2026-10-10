import type {CSSProperties, ReactNode} from "react";
import {useLook} from "./looks/look.ts";
import {ThemeScope} from "./looks/ThemeScope.tsx";

/**
 * A terminal or desk window. Its frame takes the look's chrome in the reel's theme; its content
 * paints in the look's window theme, so a dark terminal can sit on a light page.
 */
export const Window = ({
	style,
	focused = false,
	children,
}: {
	readonly style: CSSProperties;
	readonly focused?: boolean;
	readonly children: ReactNode;
}) => {
	const look = useLook();
	return (
		<div
			style={{
				...look.window,
				...(focused
					? {borderColor: "var(--accent)", boxShadow: look.glow(14) ?? look.window.boxShadow}
					: {}),
				overflow: "hidden",
				...style,
			}}
		>
			<ThemeScope theme={look.windowTheme} style={{background: "var(--surface)", height: "100%"}}>
				{children}
			</ThemeScope>
		</div>
	);
};
