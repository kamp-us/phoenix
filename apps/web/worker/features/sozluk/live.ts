/**
 * Sözlük live-publish targets — the ONE place that answers "what does mutating a
 * Definition publish to?" Binds the entity's wire `__typename` (read off the
 * view's `typeName`, never an inline `"Definition"` literal) to the
 * `Term.definitions` topic, so a resolver names the fan-out target instead of
 * restating the magic-string seam (#1127).
 *
 * No behavior change: the bound calls forward verbatim to `WorkerLivePublisher`,
 * so the published frames are byte-identical to the prior inline wiring — the
 * typename is the SAME string (`DefinitionView.typeName === "Definition"`), just
 * sourced from the view. The `changed` hint stays a per-resolver argument (it is
 * mutation-specific and does not reach the wire; see `fate-live/live-publisher.ts`).
 *
 * `appendNode` (the create-time node broadcast, the #1205 leak surface) takes a
 * `PublishDecision` and gates through `broadcastIf` — so a resolver cannot broadcast
 * a node to this viewer-blind public topic without discharging the sandbox check
 * (#1280). `deleteEdge` carries no node payload, so it stays ungated.
 */

import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {LiveTopic} from "../fate-live/protocol.ts";
import {broadcastIf, type PublishDecision} from "../kunye/sandbox.ts";
import {DefinitionView} from "./views.ts";

const DEFINITION = DefinitionView.typeName;

/**
 * Bind sözlük's publish targets to the per-request publisher. `term(slug)` is the
 * args-scoped `Term.definitions` connection keyed by the parent term.
 */
export const sozlukLive = (live: WorkerLivePublisher) => ({
	definition: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(DEFINITION, id, options),
		delete: (id: string | number) => live.delete(DEFINITION, id),
		/** The args-scoped `Term.definitions` connection for one parent term. */
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
