import {useCurrentFrame, useVideoConfig} from "remotion";
import {type Tone, toneSpans} from "../../markup.ts";
import type {TerminalLine} from "../../reel.ts";
import {TYPE_CPS, terminalCues} from "../../timeline.ts";
import {Caption} from "../Caption.tsx";
import {SAFE, SAFE_WIDTH} from "../frame.ts";
import {useLook} from "../looks/look.ts";
import {Window} from "../Window.tsx";

const TONE: Record<Tone, string> = {
	plain: "var(--text-secondary)",
	dim: "var(--text-muted)",
	ok: "var(--success)",
	warn: "var(--warning)",
	bad: "var(--danger)",
	accent: "var(--accent)",
};

const VISIBLE_LINES = 13;

export const Terminal = ({
	caption,
	title,
	lines,
}: {
	readonly caption?: string;
	readonly title?: string;
	readonly lines: ReadonlyArray<TerminalLine>;
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const time = frame / fps;
	const cues = terminalCues(lines);
	const shown = lines.flatMap((line, index) => {
		const cue = cues[index];
		if (cue === undefined || time < cue.start) return [];
		return [
			{
				line,
				index,
				typing: cue.typed && time < cue.end,
				chars: Math.floor((time - cue.start) * TYPE_CPS),
			},
		];
	});
	const visible = shown.slice(-VISIBLE_LINES);
	const blink = Math.floor(frame / 9) % 2 === 0;
	const {glow} = useLook();

	return (
		<>
			{caption === undefined ? null : <Caption text={caption} />}
			<Window
				style={{
					position: "absolute",
					top: SAFE.top + (caption === undefined ? 40 : 230),
					left: SAFE.left - 12,
					width: SAFE_WIDTH + 24,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 14,
						padding: "18px 24px",
						borderBottom: "2px solid var(--border-faint)",
						font: "500 26px/1 var(--font-mono)",
						color: "var(--text-muted)",
					}}
				>
					{["var(--danger)", "var(--warning)", "var(--success)"].map((color) => (
						<span key={color} style={{width: 18, height: 18, borderRadius: 9, background: color}} />
					))}
					<span style={{marginLeft: 12}}>{title ?? "zsh"}</span>
				</div>
				<div
					style={{padding: "22px 24px 30px", minHeight: 520, font: "500 34px/1.5 var(--font-mono)"}}
				>
					{visible.map(({line, index, typing, chars}) =>
						"cmd" in line ? (
							<div key={index} style={{color: "var(--text-primary)", whiteSpace: "pre"}}>
								<span style={{color: "var(--accent)", textShadow: glow(10)}}>$ </span>
								{typing ? line.cmd.slice(0, chars) : line.cmd}
								{typing || index === shown[shown.length - 1]?.index ? (
									<span
										style={{
											background: blink || typing ? "var(--accent)" : "transparent",
											color: "transparent",
										}}
									>
										_
									</span>
								) : null}
							</div>
						) : (
							<div key={index} style={{whiteSpace: "pre"}}>
								{toneSpans(line.out).map((span, spanIndex) => (
									<span
										key={spanIndex}
										style={{
											color: TONE[span.tone],
											textShadow: span.tone === "accent" ? glow(10) : undefined,
										}}
									>
										{span.text}
									</span>
								))}
							</div>
						),
					)}
				</div>
			</Window>
		</>
	);
};
