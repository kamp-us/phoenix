import {useFateClient} from "react-fate";
import {useVoteFlash} from "../useVoteFlash";
import {PostSaveView, PostVoteView} from "./PanoPostHeader";
import {currentLocationReturnTo, useGatedToggle, useVoteToggle} from "./useVoteToggle";
import "../vote-cue.css";
import "./PanoPost.css";

/** Presentational vote control; the parent owns the mutation + auth gate. */
export function VoteControl({
	count,
	pressed = false,
	onToggle,
	testIdSuffix,
}: {
	count: number;
	pressed?: boolean;
	onToggle?: () => void;
	testIdSuffix?: string;
}) {
	const {flashing, endFlash} = useVoteFlash(count);
	return (
		<div className="kp-pano-post__vote">
			<button
				type="button"
				className="kp-pano-post__vote-btn"
				aria-pressed={pressed}
				aria-label="yukarı oy"
				data-testid={testIdSuffix ? `post-vote-${testIdSuffix}` : undefined}
				onClick={() => onToggle?.()}
			>
				<span className="triangle" />
			</button>
			<span
				className={`kp-pano-post__vote-count${flashing ? " kp-vote-flash" : ""}`}
				onAnimationEnd={endFlash}
				data-testid={testIdSuffix ? `post-score-${testIdSuffix}` : undefined}
			>
				{count}
			</span>
		</div>
	);
}

/**
 * Triangle vote button for a single post. Dispatches
 * `fate.mutations.post.{vote,retractVote}` with an optimistic `score`/`myVote`
 * flip written back through `PostVoteView` keyed by `id`, so every card
 * referencing this post (feed + detail) re-renders instantly. The button has no
 * inline error slot, so we surface only `UNAUTHORIZED` (→ auth redirect) and
 * stay silent otherwise — see `.patterns/fate-mutations-client.md`.
 */
export function PostVoteWidget({
	postId,
	score,
	myVote,
}: {
	postId: string;
	score: number;
	myVote: boolean | null;
}) {
	const fate = useFateClient();

	const voted = myVote === true;

	const onToggle = useVoteToggle({
		voted,
		score,
		returnTo: currentLocationReturnTo,
		mutations: {
			vote: (optimistic) =>
				fate.mutations.post.vote({input: {id: postId}, optimistic, view: PostVoteView}),
			retractVote: (optimistic) =>
				fate.mutations.post.retractVote({input: {id: postId}, optimistic, view: PostVoteView}),
		},
	});

	return <VoteControl count={score} pressed={voted} onToggle={onToggle} testIdSuffix={postId} />;
}

/**
 * Bookmark toggle for a single post — the save twin of `PostVoteWidget`.
 * Dispatches `fate.mutations.post.{save,unsave}` with an optimistic `isSaved`
 * flip written back through `PostSaveView` keyed by `id`, so every card and the
 * detail header referencing this post re-render instantly (and the server's
 * `live.update("Post", id, {changed:["isSaved"]})` reconciles every other open
 * view). Like the vote widget it has no inline error slot, so it surfaces only
 * `UNAUTHORIZED` (→ auth redirect) and stays silent otherwise — see
 * `.patterns/fate-mutations-client.md`.
 */
export function PostSaveButton({postId, isSaved}: {postId: string; isSaved: boolean | null}) {
	const fate = useFateClient();

	const saved = isSaved === true;

	// The save delta is a plain `isSaved` flip (no score floor), so it drives the
	// shared gate directly rather than through the vote specialization.
	const onToggle = useGatedToggle({
		on: saved,
		returnTo: currentLocationReturnTo,
		dispatch: async (action) => {
			if (action === "unset") {
				await fate.mutations.post.unsave({
					input: {id: postId},
					optimistic: {isSaved: false},
					view: PostSaveView,
				});
			} else {
				await fate.mutations.post.save({
					input: {id: postId},
					optimistic: {isSaved: true},
					view: PostSaveView,
				});
			}
		},
	});

	return (
		<button
			type="button"
			className="kp-pano-post__save"
			aria-pressed={saved}
			data-testid={`post-save-${postId}`}
			onClick={onToggle}
		>
			{saved ? "kaydedildi" : "kaydet"}
		</button>
	);
}
