/**
 * Post surface wiring for the shared {@link ReactionBar} (#1867): binds
 * `fate.mutations.post.react` and the post's `reactions` write-back view, so the
 * pano post card renders the palette + counts and a tap fires the react/change/
 * retract mutation with an optimistic aggregate. The bar itself is
 * surface-agnostic; this is the one post-specific seam.
 */
import {useFateClient, view} from "react-fate";
import type {Post} from "../../../worker/features/fate/views";
import {currentLocationReturnTo} from "../pano/useVoteToggle";
import {ReactionBar} from "./ReactionBar";
import {useReactionBar} from "./useReactionBar";

/** Write-back view for the post react mutation — the optimistic `reactions` aggregate flips every open card. */
export const PostReactionView = view<Post>()({
	id: true,
	reactions: {counts: true, myReaction: true},
});

export function PostReactionBar({
	postId,
	reactions,
}: {
	postId: string;
	reactions: Post["reactions"];
}) {
	const fate = useFateClient();
	const onReact = useReactionBar({
		aggregate: reactions,
		returnTo: currentLocationReturnTo,
		dispatch: ({emoji, optimistic}) =>
			fate.mutations.post.react({
				input: {id: postId, emoji},
				optimistic: {reactions: optimistic},
				view: PostReactionView,
			}),
	});
	return <ReactionBar aggregate={reactions} onReact={onReact} testIdSuffix={postId} />;
}
