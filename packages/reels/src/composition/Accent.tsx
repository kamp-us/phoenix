import {accentSpans} from "../markup.ts";
import {glow} from "./frame.ts";

/** Display text with its `*accent*` spans painted in the accent. */
export const Accent = ({text}: {readonly text: string}) => (
	<>
		{accentSpans(text).map((span, index) =>
			span.accent ? (
				<span key={index} style={{color: "var(--accent)", textShadow: glow(18)}}>
					{span.text}
				</span>
			) : (
				<span key={index}>{span.text}</span>
			),
		)}
	</>
);
