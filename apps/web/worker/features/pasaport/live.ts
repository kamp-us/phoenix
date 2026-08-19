/**
 * Pasaport's live-publish targets — the one place that answers "what does a pasaport
 * mutation publish to?" The typename is read off the view rather than written as an
 * inline literal (#1127).
 *
 * The only live seam today is the tier flip (#1886). `User` is the entity the
 * app-lifetime global live pin subscribes (ADR 0094, see
 * .patterns/fate-live-consistency.md#global-pin), so an update reaches every open
 * view of the promoted member.
 */

import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {UserView} from "./views.ts";

const USER = UserView.typeName;

/** Bind pasaport's publish targets to the per-request publisher. */
export const pasaportLive = (live: WorkerLivePublisher) => ({
	user: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(USER, id, options),
	},
});
