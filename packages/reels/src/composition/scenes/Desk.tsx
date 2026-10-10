import {interpolate, useCurrentFrame, useVideoConfig} from "remotion";
import {DESK_STEP} from "../../timeline.ts";
import {Caption} from "../Caption.tsx";
import {SAFE, SAFE_WIDTH} from "../frame.ts";
import {Window} from "../Window.tsx";

const PANE_LINES = 6;

/** A Tuval desk: one window per program, every program working at once. */
export const Desk = ({
	caption,
	panes,
}: {
	readonly caption?: string;
	readonly panes: ReadonlyArray<{readonly program: string; readonly lines: ReadonlyArray<string>}>;
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const time = frame / fps;
	const top = SAFE.top + (caption === undefined ? 40 : 230);
	const columns = panes.length > 2 ? 2 : 1;
	const rows = Math.ceil(panes.length / columns);
	const gap = 18;
	const paneWidth = (SAFE_WIDTH + 24 - gap * (columns - 1)) / columns;
	const paneHeight = Math.min(420, (820 - gap * (rows - 1)) / rows);
	const focused = Math.floor(time / 1.2) % panes.length;

	return (
		<>
			{caption === undefined ? null : <Caption text={caption} />}
			{panes.map((pane, index) => {
				const column = index % columns;
				const row = Math.floor(index / columns);
				const appear = interpolate(frame, [index * 3, index * 3 + 10], [0, 1], {
					extrapolateRight: "clamp",
				});
				const shown = pane.lines.filter((_, line) => time >= 0.5 + line * DESK_STEP + index * 0.12);
				const isFocused = index === focused;
				return (
					<Window
						key={index}
						focused={isFocused}
						style={{
							position: "absolute",
							left: SAFE.left - 12 + column * (paneWidth + gap),
							top: top + row * (paneHeight + gap),
							width: paneWidth,
							height: paneHeight,
							opacity: appear,
							scale: `${0.94 + appear * 0.06}`,
						}}
					>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								padding: "12px 18px",
								borderBottom: "2px solid var(--border-faint)",
								font: "600 24px/1 var(--font-mono)",
								color: isFocused ? "var(--accent)" : "var(--text-muted)",
							}}
						>
							<span>{pane.program}</span>
							<span style={{color: "var(--success)"}}>
								{shown.length < pane.lines.length ? "● running" : "● idle"}
							</span>
						</div>
						<div
							style={{
								padding: "12px 18px",
								font: "500 23px/1.45 var(--font-mono)",
								color: "var(--text-secondary)",
							}}
						>
							{shown.slice(-PANE_LINES).map((line, lineIndex) => (
								<div
									key={lineIndex}
									style={{whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"}}
								>
									{line}
								</div>
							))}
						</div>
					</Window>
				);
			})}
		</>
	);
};
