/**
 * Hearthstone Battlegrounds Spectator & Jev AI Strategy Program for Tuval.
 * Connects to a live stream bridge (local, tailscale, or Cloudflare LiveDO room)
 * and maintains the reactive Battlegrounds board state and Jev AI turn recommendations.
 */

import {
	type Answer,
	type AnyProgram,
	type AuthoredEvent,
	defineProgram,
} from "@kampus/tuval-sdk/authoring";
import {defaultHSBGState, type HSBGSpectatorState} from "./hsbg-state.ts";

export type {
	HSBGAdviceLine,
	HSBGMinion,
	HSBGPlayerState,
	HSBGSpectatorState,
} from "./hsbg-state.ts";
export {defaultHSBGState, isHSBGSpectatorState} from "./hsbg-state.ts";

import {HSBG_SPECTATOR_PROGRAM, HSBG_SPECTATOR_WINDOW_REF} from "./renderer-ref.ts";

export interface SetStreamUrlEvent extends AuthoredEvent {
	readonly url: string;
}

export interface StateReceivedEvent extends AuthoredEvent {
	readonly payload: Partial<HSBGSpectatorState>;
}

export interface StreamErrorEvent extends AuthoredEvent {
	readonly error: string;
}

export type HSBGMsg =
	| ({readonly type: "set_stream_url"} & SetStreamUrlEvent)
	| {readonly type: "stream_connected"}
	| ({readonly type: "stream_error"} & StreamErrorEvent)
	| ({readonly type: "state_received"} & StateReceivedEvent);

export interface HSBGOptions {
	readonly streamUrl?: string;
}

const POLL_INTERVAL_MS = 1500;

/** A bare room name (e.g. "swift-wolf-42") resolves to its kamp.us relay room. */
const pollUrlOf = (streamUrl: string): string => {
	const url = streamUrl.trim();
	if (!url.startsWith("http://") && !url.startsWith("https://")) {
		return `https://kamp.us/api/hsbg/rooms/${encodeURIComponent(url)}`;
	}
	if (!url.includes("/api/")) return `${url.replace(/\/+$/, "")}/api/state`;
	return url;
};

const pollRoom = (pollUrl: string, dispatch: (event: AuthoredEvent) => void): (() => void) => {
	let active = true;
	const fetchState = async () => {
		try {
			const res = await fetch(pollUrl);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (active && !data.error) {
				const received: StateReceivedEvent = {type: "state_received", payload: data};
				dispatch(received);
			}
		} catch (err: unknown) {
			if (active) {
				const failed: StreamErrorEvent = {
					type: "stream_error",
					error: err instanceof Error ? err.message : "Failed to connect",
				};
				dispatch(failed);
			}
		}
	};
	void fetchState();
	const timer = setInterval(fetchState, POLL_INTERVAL_MS);
	return () => {
		active = false;
		clearInterval(timer);
	};
};

export const hsbgProgram = (options?: HSBGOptions): AnyProgram => {
	const initialUrl = options?.streamUrl ?? "http://localhost:7860";

	return defineProgram({
		id: HSBG_SPECTATOR_PROGRAM,
		init: (): HSBGSpectatorState => ({
			...defaultHSBGState,
			streamUrl: initialUrl,
		}),
		update: {
			set_stream_url: (
				state: HSBGSpectatorState,
				event: SetStreamUrlEvent,
			): Answer<HSBGSpectatorState> => [
				{...state, streamUrl: event.url, isConnected: false, error: null},
				[],
			],
			stream_connected: (state: HSBGSpectatorState): Answer<HSBGSpectatorState> => [
				{...state, isConnected: true, error: null},
				[],
			],
			stream_error: (
				state: HSBGSpectatorState,
				event: StreamErrorEvent,
			): Answer<HSBGSpectatorState> => [{...state, isConnected: false, error: event.error}, []],
			state_received: (
				state: HSBGSpectatorState,
				event: StateReceivedEvent,
			): Answer<HSBGSpectatorState> => [
				{
					...state,
					...event.payload,
					isConnected: true,
					error: null,
				},
				[],
			],
		},
		subs: [{type: "poll", deps: (state: HSBGSpectatorState) => pollUrlOf(state.streamUrl)}],
		subscribe: {
			poll: (sub, dispatch) =>
				typeof sub.deps === "string" ? pollRoom(sub.deps, dispatch) : () => undefined,
		},
		renderer: HSBG_SPECTATOR_WINDOW_REF,
	});
};
