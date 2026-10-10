import {accentSpans} from "../markup.ts";
import {useLook} from "./looks/look.ts";

/** Display text with its `*accent*` spans painted by the look; `from` is when the text lands. */
export const Accent = ({text, from = 0}: {readonly text: string; readonly from?: number}) => {
	const {AccentSpan} = useLook();
	return (
		<>
			{accentSpans(text).map((span, index) =>
				span.accent ? (
					<AccentSpan key={index} from={from}>
						{span.text}
					</AccentSpan>
				) : (
					<span key={index}>{span.text}</span>
				),
			)}
		</>
	);
};
