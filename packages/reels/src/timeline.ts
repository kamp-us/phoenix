/**
 * The timeline: how long each scene of a reel holds, and whether the reel fits the vertical
 * short-form medium. Durations are derived from content, never authored, so a scene always
 * stays on screen long enough to read and never longer.
 */
import type {Reel, Scene} from "./reel.ts";

export const FPS = 30;

/** Characters per second a typed terminal command advances. */
export const TYPE_CPS = 32;

/** Seconds before the next output line appears. */
const OUT_STEP = 0.22;

/** Seconds a viewer needs per displayed word, plus a fixed settle time. */
const READ_PER_WORD = 0.32;
const READ_SETTLE = 1.1;

/** The platforms' hard ceiling is higher; past this, completion rate collapses. */
export const MAX_SECONDS = 59;

/** The hook must land before the first swipe decision. */
export const MAX_HOOK_SECONDS = 3;

/** Characters that fit one display line of a 1080px-wide terminal at the stage's type size. */
export const TERMINAL_COLUMNS = 40;

const words = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;

const reading = (...texts: ReadonlyArray<string | undefined>): number =>
	READ_SETTLE + READ_PER_WORD * texts.reduce((sum, text) => sum + (text ? words(text) : 0), 0);

export const sceneSeconds = (scene: Scene): number => {
	switch (scene._tag) {
		case "hook":
			return Math.min(MAX_HOOK_SECONDS, 0.6 + reading(scene.text) * 0.8);
		case "terminal": {
			const cues = terminalCues(scene.lines);
			const last = cues[cues.length - 1]?.end ?? 0;
			return Math.max(last + 1.6, reading(scene.caption));
		}
		case "pipeline":
			return 0.6 + scene.stages.length * PIPELINE_STEP + (scene.stamp ? 1.4 : 0.8);
		case "versus":
			return 0.6 + reading(scene.before) * 0.6 + reading(scene.after);
		case "stat":
			return 1.0 + reading(scene.label);
		case "desk": {
			const longest = Math.max(...scene.panes.map((pane) => pane.lines.length));
			return Math.max(1.4 + longest * DESK_STEP, reading(scene.caption));
		}
		case "outro":
			return 1.2 + reading(scene.text);
	}
};

/** When, in seconds from its scene's start, each line of a terminal starts and finishes. */
export interface LineCue {
	readonly start: number;
	readonly end: number;
	readonly typed: boolean;
}

export const terminalCues = (
	lines: ReadonlyArray<{cmd: string} | {out: string}>,
): ReadonlyArray<LineCue> => {
	let cursor = 0.5;
	return lines.map((line) => {
		const start = cursor;
		const end = "cmd" in line ? start + line.cmd.length / TYPE_CPS : start;
		cursor = "cmd" in line ? end + 0.35 : start + OUT_STEP;
		return {start, end, typed: "cmd" in line};
	});
};

/** Seconds between two hook words appearing. */
export const HOOK_WORD_STEP = 0.11;

/** Seconds between two pipeline stages lighting up. */
export const PIPELINE_STEP = 0.75;

/** Seconds between two desk lines appearing in one pane. */
export const DESK_STEP = 0.45;

/**
 * The moments inside a scene that the stage animates and the soundtrack accents, in seconds
 * from the scene's start. Both read this one list, so a sound never drifts from its picture.
 */
export const sceneBeats = (scene: Scene): ReadonlyArray<number> => {
	switch (scene._tag) {
		case "hook":
			return scene.text.split(/\s+/).map((_, index) => 0.15 + index * HOOK_WORD_STEP);
		case "terminal":
			return terminalCues(scene.lines)
				.filter((cue) => !cue.typed)
				.map((cue) => cue.start);
		case "pipeline":
			return [
				...scene.stages.map((_, index) => 0.5 + index * PIPELINE_STEP),
				...(scene.stamp ? [0.6 + scene.stages.length * PIPELINE_STEP] : []),
			];
		case "versus":
			return [0.3, 0.6 + reading(scene.before) * 0.6];
		case "stat":
			return [0.2, 1.0];
		case "desk":
			return [];
		case "outro":
			return [0.3];
	}
};

export interface SceneWindow {
	readonly index: number;
	readonly startFrame: number;
	readonly frames: number;
}

export interface Timeline {
	readonly fps: number;
	readonly totalFrames: number;
	readonly scenes: ReadonlyArray<SceneWindow>;
}

export const planTimeline = (reel: Reel): Timeline => {
	let cursor = 0;
	const scenes = reel.scenes.map((scene, index) => {
		const frames = Math.round(sceneSeconds(scene) * FPS);
		const window = {index, startFrame: cursor, frames};
		cursor += frames;
		return window;
	});
	return {fps: FPS, totalFrames: cursor, scenes};
};

export type Verdict =
	| {readonly _tag: "Fits"; readonly seconds: number}
	| {readonly _tag: "Refused"; readonly reasons: ReadonlyArray<string>};

/** Whether a reel works in the medium: hook first and fast, under a minute, nothing overflows. */
export const judgeReel = (reel: Reel): Verdict => {
	const reasons: Array<string> = [];
	const [first] = reel.scenes;
	if (first._tag !== "hook") reasons.push(`scene 0 is ${first._tag}; a reel opens on its hook`);
	const last = reel.scenes[reel.scenes.length - 1];
	if (last?._tag !== "outro") reasons.push("the last scene is not an outro");
	if (first._tag === "hook" && words(first.text) > 12) {
		reasons.push(`the hook has ${words(first.text)} words; it must read in one glance (12 max)`);
	}
	reel.scenes.forEach((scene, index) => {
		if (scene._tag !== "terminal") return;
		scene.lines.forEach((line) => {
			const text = "cmd" in line ? `$ ${line.cmd}` : line.out;
			const visible = text.replace(/\[\/?[a-z]+\]/g, "");
			if (visible.length > TERMINAL_COLUMNS) {
				reasons.push(
					`scene ${index} line "${visible}" is ${visible.length} columns; the terminal fits ${TERMINAL_COLUMNS}`,
				);
			}
		});
	});
	const seconds = planTimeline(reel).totalFrames / FPS;
	if (seconds > MAX_SECONDS) reasons.push(`${seconds.toFixed(1)}s exceeds ${MAX_SECONDS}s`);
	return reasons.length === 0 ? {_tag: "Fits", seconds} : {_tag: "Refused", reasons};
};
