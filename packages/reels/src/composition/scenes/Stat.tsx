import {Easing, interpolate, useCurrentFrame, useVideoConfig} from "remotion";
import {Accent} from "../Accent.tsx";
import {glow, SAFE, SAFE_WIDTH} from "../frame.ts";

export const Stat = ({
	value,
	suffix,
	label,
}: {
	readonly value: number;
	readonly suffix?: string;
	readonly label: string;
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const progress = interpolate(frame, [0.2 * fps, 1.0 * fps], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.out(Easing.cubic),
	});
	return (
		<div style={{position: "absolute", top: SAFE.top + 260, left: SAFE.left, width: SAFE_WIDTH}}>
			<div
				style={{
					font: "700 230px/1 var(--font-mono)",
					fontVariantNumeric: "tabular-nums",
					letterSpacing: "-0.04em",
					color: "var(--accent)",
					textShadow: glow(30),
				}}
			>
				{Math.round(value * progress).toLocaleString("en-US")}
				{suffix ?? ""}
			</div>
			<div
				style={{
					marginTop: 40,
					font: "600 62px/1.15 var(--font-body)",
					color: "var(--text-primary)",
					opacity: interpolate(frame, [0.6 * fps, 1.0 * fps], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
					}),
				}}
			>
				<Accent text={label} />
			</div>
		</div>
	);
};
