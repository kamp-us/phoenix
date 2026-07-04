/**
 * Definition surface wiring for the shared {@link ReactionBar} (#1867): binds
 * `fate.mutations.definition.react` and the definition's `reactions` write-back
 * view. A signed-out (or `UNAUTHORIZED`) tap returns to the term page, not the
 * current location — the card renders inside the `/sozluk/:slug` route, mirroring
 * the definition vote's `returnTo`.
 */
import {useFateClient, view} from "react-fate";
import type {Definition} from "../../../worker/features/fate/views";
import {ReactionBar} from "./ReactionBar";
import {useReactionBar} from "./useReactionBar";

/** Write-back view for the definition react mutation. */
export const DefinitionReactionView = view<Definition>()({
	id: true,
	reactions: {counts: true, myReaction: true},
});

export function DefinitionReactionBar({
	definitionId,
	slug,
	reactions,
}: {
	definitionId: string;
	slug: string;
	reactions: Definition["reactions"];
}) {
	const fate = useFateClient();
	const onReact = useReactionBar({
		aggregate: reactions,
		returnTo: () => `/sozluk/${slug}`,
		dispatch: ({emoji, optimistic}) =>
			fate.mutations.definition.react({
				input: {id: definitionId, emoji},
				optimistic: {reactions: optimistic},
				view: DefinitionReactionView,
			}),
	});
	return <ReactionBar aggregate={reactions} onReact={onReact} testIdSuffix={definitionId} />;
}
