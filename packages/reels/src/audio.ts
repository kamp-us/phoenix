/**
 * The soundtrack: a synthesized music bed plus sound effects placed on the timeline's cues.
 * Everything is generated here from a seeded PRNG, so a render is reproducible and carries no
 * licensed audio.
 */
import type {Reel} from "./reel.ts";
import {FPS, sceneBeats, type Timeline, TYPE_CPS, terminalCues} from "./timeline.ts";

export const SAMPLE_RATE = 44_100;

export type SoundKind = "key" | "blip" | "whoosh" | "stamp";

export interface SoundEvent {
	readonly kind: SoundKind;
	readonly at: number;
	/** Position within its run (a hook's word, a pipeline's stage), which raises a blip's pitch. */
	readonly step: number;
}

/** Every effect the picture asks for, in seconds from the reel's start. */
export const soundEvents = (reel: Reel, timeline: Timeline): ReadonlyArray<SoundEvent> => {
	const events: Array<SoundEvent> = [];
	reel.scenes.forEach((scene, index) => {
		const window = timeline.scenes[index];
		if (window === undefined) return;
		const offset = window.startFrame / FPS;
		if (index > 0) events.push({kind: "whoosh", at: Math.max(0, offset - 0.18), step: 0});
		if (scene._tag === "terminal") {
			terminalCues(scene.lines).forEach((cue) => {
				if (!cue.typed) return;
				for (let at = cue.start; at < cue.end; at += 1 / TYPE_CPS) {
					events.push({kind: "key", at: offset + at, step: 0});
				}
			});
		}
		const beats = sceneBeats(scene);
		beats.forEach((beat, step) => {
			const isStamp =
				scene._tag === "pipeline" && scene.stamp !== undefined && step === beats.length - 1;
			events.push({kind: isStamp ? "stamp" : "blip", at: offset + beat, step});
		});
	});
	return events.sort((a, b) => a.at - b.at);
};

const mulberry32 = (seed: number) => () => {
	seed += 0x6d2b79f5;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);

const BPM = 96;
const BEAT = 60 / BPM;

/** A minor walk (Am – F – C – G), two bars a chord, as MIDI notes. */
const PROGRESSION: ReadonlyArray<ReadonlyArray<number>> = [
	[57, 60, 64, 69],
	[53, 57, 60, 65],
	[48, 55, 60, 64],
	[55, 59, 62, 67],
];

const seedOf = (id: string): number =>
	[...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7);

/** Renders the reel's soundtrack as a 16-bit stereo WAV of exactly `seconds`. */
export const synthesize = (reel: Reel, timeline: Timeline): Uint8Array => {
	const seconds = timeline.totalFrames / FPS;
	const length = Math.ceil(seconds * SAMPLE_RATE);
	const left = new Float32Array(length);
	const right = new Float32Array(length);
	const random = mulberry32(seedOf(reel.id));

	const add = (
		at: number,
		duration: number,
		voice: (t: number) => number,
		gain: number,
		pan = 0,
	) => {
		const from = Math.max(0, Math.floor(at * SAMPLE_RATE));
		const to = Math.min(length, Math.floor((at + duration) * SAMPLE_RATE));
		for (let i = from; i < to; i++) {
			const sample = voice((i - from) / SAMPLE_RATE) * gain;
			left[i] = (left[i] ?? 0) + sample * (1 - pan) * 0.5 * 2;
			right[i] = (right[i] ?? 0) + sample * (1 + pan) * 0.5 * 2;
		}
	};

	const bar = BEAT * 4;
	for (let chordAt = 0, chord = 0; chordAt < seconds; chordAt += bar * 2, chord++) {
		const notes = PROGRESSION[chord % PROGRESSION.length] ?? [];
		const span = bar * 2;
		notes.forEach((note, voiceIndex) => {
			const freq = midi(note);
			const detune = 1 + (voiceIndex % 2 === 0 ? 0.002 : -0.002);
			add(
				chordAt,
				span + 0.4,
				(t) => {
					const envelope = Math.min(1, t / 0.6) * Math.min(1, Math.max(0, (span + 0.4 - t) / 0.6));
					const wobble = 1 + 0.15 * Math.sin(2 * Math.PI * 0.25 * t);
					return (
						envelope *
						wobble *
						(Math.sin(2 * Math.PI * freq * t) +
							0.35 * Math.sin(2 * Math.PI * freq * detune * 2 * t) +
							0.12 * Math.sin(2 * Math.PI * freq * 3 * t))
					);
				},
				0.035,
				voiceIndex % 2 === 0 ? -0.4 : 0.4,
			);
		});
		const root = midi((notes[0] ?? 57) - 24);
		for (let beat = 0; beat < 8; beat++) {
			const at = chordAt + beat * BEAT;
			if (at >= seconds) break;
			add(at, BEAT, (t) => Math.exp(-t * 3.5) * Math.sin(2 * Math.PI * root * t), 0.16);
			if (beat % 2 === 0) {
				add(
					at,
					0.3,
					(t) => Math.exp(-t * 14) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 30)) * t),
					0.45,
				);
			}
			let previous = 0;
			add(
				at + BEAT / 2,
				0.05,
				(t) => {
					const noise = random() * 2 - 1;
					const high = noise - previous;
					previous = noise;
					return Math.exp(-t * 90) * high;
				},
				0.05,
				0.3,
			);
		}
	}

	for (const event of soundEvents(reel, timeline)) {
		switch (event.kind) {
			case "key": {
				const tone = 1800 + random() * 900;
				const level = 0.06 + random() * 0.05;
				add(
					event.at,
					0.03,
					(t) =>
						Math.exp(-t * 260) *
						((random() * 2 - 1) * 0.7 + 0.3 * Math.sin(2 * Math.PI * tone * t)),
					level,
					random() * 0.4 - 0.2,
				);
				break;
			}
			case "blip": {
				const freq = midi(76 + ((event.step * 2) % 12));
				add(event.at, 0.18, (t) => Math.exp(-t * 22) * Math.sin(2 * Math.PI * freq * t), 0.12);
				break;
			}
			case "stamp":
				add(
					event.at,
					0.5,
					(t) =>
						Math.exp(-t * 9) *
						(Math.sin(2 * Math.PI * (60 + 140 * Math.exp(-t * 20)) * t) +
							0.4 * (random() * 2 - 1) * Math.exp(-t * 30)),
					0.5,
				);
				break;
			case "whoosh":
				add(event.at, 0.36, (t) => Math.sin((Math.PI * t) / 0.36) ** 2 * (random() * 2 - 1), 0.045);
				break;
		}
	}

	const fade = Math.min(length, Math.floor(0.8 * SAMPLE_RATE));
	for (let i = 0; i < fade; i++) {
		const gain = i / fade;
		left[length - 1 - i] = (left[length - 1 - i] ?? 0) * gain;
		right[length - 1 - i] = (right[length - 1 - i] ?? 0) * gain;
	}

	return encodeWav(left, right);
};

const encodeWav = (left: Float32Array, right: Float32Array): Uint8Array => {
	const frames = left.length;
	const bytes = new Uint8Array(44 + frames * 4);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + frames * 4, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, frames * 4, true);
	for (let i = 0; i < frames; i++) {
		view.setInt16(44 + i * 4, Math.round(Math.tanh(left[i] ?? 0) * 32767), true);
		view.setInt16(46 + i * 4, Math.round(Math.tanh(right[i] ?? 0) * 32767), true);
	}
	return bytes;
};
