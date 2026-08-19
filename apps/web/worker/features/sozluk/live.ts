/**
 * Sözlük's live-publish targets — the one place that answers "what does mutating a
 * Definition publish to?" The typename is read off the view rather than written as an
 * inline literal, so a resolver names its fan-out target instead of restating the
 * magic string (#1127).
 *
 * `appendNode` takes a `PublishDecision` and gates through `broadcastIf`, so a
 * resolver cannot broadcast a node to this viewer-blind public topic without
 * discharging the sandbox check (#1280). `deleteEdge` carries no node payload and
 * stays ungated.
 */

import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {LiveTopic} from "../fate-live/protocol.ts";
import {broadcastIf, type PublishDecision} from "../kunye/sandbox.ts";
import {DefinitionView} from "./views.ts";

const DEFINITION = DefinitionView.typeName;

export const sozlukLive = (live: WorkerLivePublisher) => ({
	definition: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(DEFINITION, id, options),
		delete: (id: string | number) => live.delete(DEFINITION, id),
		term: (slug: string) => {
			const topic = live.topic(LiveTopic.termDefinitions, {id: slug});
			return {
				appendNode: (
					id: string | number,
					options: {node?: unknown; eventId?: string},
					decision: PublishDecision,
				) => broadcastIf(decision, topic.appendNode(DEFINITION, id, options)),
				deleteEdge: (id: string | number, options?: {eventId?: string}) =>
					topic.deleteEdge(DEFINITION, id, options),
			};
		},
	},
});
