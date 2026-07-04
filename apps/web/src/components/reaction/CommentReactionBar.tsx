/**
 * Comment surface wiring for the shared {@link ReactionBar} (#1867): binds
 * `fate.mutations.comment.react` and the comment's `reactions` write-back view.
 * The pano comment tree node renders this behind the reaction flag.
 */
import {useFateClient, view} from "react-fate";
import type {Comment} from "../../../worker/features/fate/views";
import {currentLocationReturnTo} from "../pano/useVoteToggle";
import {ReactionBar} from "./ReactionBar";
import {useReactionBar} from "./useReactionBar";

/** Write-back view for the comment react mutation. */
export const CommentReactionView = view<Comment>()({
	id: true,
	reactions: {counts: true, myReaction: true},
});

export function CommentReactionBar({
	commentId,
	reactions,
}: {
	commentId: string;
	reactions: Comment["reactions"];
}) {
	const fate = useFateClient();
	const onReact = useReactionBar({
		aggregate: reactions,
		returnTo: currentLocationReturnTo,
		dispatch: ({emoji, optimistic}) =>
			fate.mutations.comment.react({
				input: {id: commentId, emoji},
				optimistic: {reactions: optimistic},
				view: CommentReactionView,
			}),
	});
	return <ReactionBar aggregate={reactions} onReact={onReact} testIdSuffix={commentId} />;
}
