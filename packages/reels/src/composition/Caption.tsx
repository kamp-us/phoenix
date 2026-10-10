import {interpolate, useCurrentFrame} from "remotion";
import {Accent} from "./Accent.tsx";
import {SAFE, SAFE_WIDTH} from "./frame.ts";
import {useLook} from "./looks/look.ts";

/**
 * Scenes place their body a fixed distance below the caption, which fits two lines; a look may
 * enlarge captions only this far before the second line runs into the body.
 */
const CAPTION_SCALE_CAP = 1.06;

/** The headline a scene carries above its body, readable with the sound off. */
export const Caption = ({text}: {readonly text: string}) => {
	const frame = useCurrentFrame();
	const {display} = useLook();
	return (
		<div
			style={{
				position: "absolute",
				top: SAFE.top,
				left: SAFE.left,
				width: SAFE_WIDTH,
				font: `${display.weight} ${Math.round(64 * Math.min(display.scale, CAPTION_SCALE_CAP))}px/1.12 var(--font-body)`,
				letterSpacing: display.tracking,
				color: "var(--text-primary)",
				opacity: interpolate(frame, [0, 8], [0, 1], {extrapolateRight: "clamp"}),
				transform: `translateY(${interpolate(frame, [0, 8], [24, 0], {extrapolateRight: "clamp"})}px)`,
			}}
		>
			<Accent text={text} from={4} />
		</div>
	);
};
