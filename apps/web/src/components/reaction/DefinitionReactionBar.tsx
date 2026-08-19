// `returnTo` is the term page, not the current location like the other two surfaces —
// the card renders inside `/sozluk/:slug`, mirroring the definition vote.
import {useFateClient, view} from "react-fate";
import type {Definition} from "../../../worker/features/fate/views";
import {ReactionBar} from "./ReactionBar";
import {useReactionBar} from "./useReactionBar";

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
