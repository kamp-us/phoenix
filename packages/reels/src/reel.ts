/**
 * A reel script: the authored, vertical short-form video one render produces. The stage
 * (`stage/stage.js`) paints it; the timeline (`timeline.ts`) decides how long each scene holds.
 */
import * as Schema from "effect/Schema";

export const Brand = Schema.Literals(["fabrika", "tuval"]);
export type Brand = typeof Brand.Type;

/** `*word*` in any display text paints that word in the accent. */
const Text = Schema.String;

const HookScene = Schema.TaggedStruct("hook", {
	kicker: Schema.optionalKey(Text),
	text: Text,
});

/** One terminal line: a typed command, or output that appears at once. */
export const TerminalLine = Schema.Union([
	Schema.Struct({cmd: Schema.String}),
	Schema.Struct({out: Schema.String}),
]);
export type TerminalLine = typeof TerminalLine.Type;

const TerminalScene = Schema.TaggedStruct("terminal", {
	caption: Schema.optionalKey(Text),
	title: Schema.optionalKey(Schema.String),
	lines: Schema.NonEmptyArray(TerminalLine),
});

const PipelineStage = Schema.Struct({name: Schema.String, detail: Schema.String});

const PipelineScene = Schema.TaggedStruct("pipeline", {
	caption: Schema.optionalKey(Text),
	stages: Schema.NonEmptyArray(PipelineStage),
	stamp: Schema.optionalKey(Schema.String),
});

const VersusScene = Schema.TaggedStruct("versus", {
	before: Text,
	after: Text,
});

const StatScene = Schema.TaggedStruct("stat", {
	value: Schema.Int,
	suffix: Schema.optionalKey(Schema.String),
	label: Text,
});

const DeskPane = Schema.Struct({
	program: Schema.String,
	lines: Schema.NonEmptyArray(Schema.String),
});

const DeskScene = Schema.TaggedStruct("desk", {
	caption: Schema.optionalKey(Text),
	panes: Schema.NonEmptyArray(DeskPane),
});

const OutroScene = Schema.TaggedStruct("outro", {
	text: Text,
	cta: Schema.String,
});

export const Scene = Schema.Union([
	HookScene,
	TerminalScene,
	PipelineScene,
	VersusScene,
	StatScene,
	DeskScene,
	OutroScene,
]);
export type Scene = typeof Scene.Type;

export const Reel = Schema.Struct({
	id: Schema.String,
	brand: Brand,
	title: Schema.String,
	description: Schema.String,
	hashtags: Schema.Array(Schema.String),
	scenes: Schema.NonEmptyArray(Scene),
});
export type Reel = typeof Reel.Type;

export const decodeReel = Schema.decodeUnknownEffect(Reel);
