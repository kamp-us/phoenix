import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {accentWords} from "../../markup.ts";
import {HOOK_WORD_STEP} from "../../timeline.ts";
import {glow, SAFE, SAFE_WIDTH} from "../frame.ts";

export const Hook = ({kicker, text}: {readonly kicker?: string; readonly text: string}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	return (
		<div style={{position: "absolute", top: SAFE.top + 220, left: SAFE.left, width: SAFE_WIDTH}}>
			{kicker === undefined ? null : (
				<div
					style={{
						font: "600 34px/1 var(--font-mono)",
						color: "var(--accent)",
						textTransform: "uppercase",
						letterSpacing: "0.12em",
						marginBottom: 36,
						opacity: interpolate(frame, [0, 6], [0, 1], {extrapolateRight: "clamp"}),
					}}
				>
					{`> ${kicker}`}
					<span style={{opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0}}>_</span>
				</div>
			)}
			<div
				style={{
					font: "700 112px/1.02 var(--font-body)",
					letterSpacing: "-0.035em",
					color: "var(--text-primary)",
				}}
			>
				{accentWords(text).map((word, index) => {
					const pop = spring({
						frame: frame - Math.round((0.15 + index * HOOK_WORD_STEP) * fps),
						fps,
						config: {damping: 12, stiffness: 220},
					});
					return (
						<span
							key={index}
							style={{
								display: "inline-block",
								marginRight: "0.24em",
								opacity: pop,
								transform: `translateY(${(1 - pop) * 40}px) scale(${0.85 + pop * 0.15})`,
								color: word.accent ? "var(--accent)" : undefined,
								textShadow: word.accent ? glow(24) : undefined,
							}}
						>
							{word.text}
						</span>
					);
				})}
			</div>
		</div>
	);
};
