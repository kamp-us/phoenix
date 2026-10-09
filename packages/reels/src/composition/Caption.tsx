import {interpolate, useCurrentFrame} from "remotion";
import {Accent} from "./Accent.tsx";
import {SAFE, SAFE_WIDTH} from "./frame.ts";

/** The headline a scene carries above its body, readable with the sound off. */
export const Caption = ({text}: {readonly text: string}) => {
	const frame = useCurrentFrame();
	return (
		<div
			style={{
				position: "absolute",
				top: SAFE.top,
				left: SAFE.left,
				width: SAFE_WIDTH,
				font: `700 64px/1.12 var(--font-body)`,
				letterSpacing: "-0.02em",
				color: "var(--text-primary)",
				opacity: interpolate(frame, [0, 8], [0, 1], {extrapolateRight: "clamp"}),
				transform: `translateY(${interpolate(frame, [0, 8], [24, 0], {extrapolateRight: "clamp"})}px)`,
			}}
		>
			<Accent text={text} />
		</div>
	);
};
