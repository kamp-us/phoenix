import {useFateClient, view} from "react-fate";
import type {Post} from "../../../worker/features/fate/views";
import {currentLocationReturnTo} from "../pano/useVoteToggle";
import {ReactionBar} from "./ReactionBar";
import {useReactionBar} from "./useReactionBar";

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
