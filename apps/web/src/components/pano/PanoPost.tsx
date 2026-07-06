import {useFateClient} from "react-fate";
import {useVoteFlash} from "../useVoteFlash";
import {PostSaveView, PostVoteView} from "./PanoPostHeader";
import {currentLocationReturnTo, useGatedToggle, useVoteToggle} from "./useVoteToggle";
import "../vote-cue.css";
import "./PanoPost.css";

/**
 * Presentational vote control; the parent owns the mutation + auth gate. `own`
 * marks the viewer's own content: the vote button is dropped (self-voting is
 * blocked, #2216) while the score still renders, so the affordance matches the
 * rule — the server guard is the invariant, this is the matching UX.
 */
export function VoteControl({
	count,
	pressed = false,
	onToggle,
	testIdSuffix,
	own = false,
}: {
	count: number;
	pressed?: boolean;
	onToggle?: () => void;
	testIdSuffix?: string;
	own?: boolean;
}) {
	const {flashing, endFlash} = useVoteFlash(count);
	return (
		<div className="kp-pano-post__vote">
			{own ? null : (
				<button
					type="button"
					className="kp-pano-post__vote-btn"
					aria-pressed={pressed}
					aria-label="Yukarı oy"
					data-testid={testIdSuffix ? `post-vote-${testIdSuffix}` : undefined}
					onClick={() => onToggle?.()}
				>
					<span className="triangle" />
				</button>
			)}
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
	own = false,
}: {
	postId: string;
	score: number;
	myVote: boolean | null;
	/** The viewer authored this post — drop the vote button (self-vote is blocked, #2216). */
	own?: boolean;
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

	return (
		<VoteControl
			count={score}
			pressed={voted}
			onToggle={onToggle}
			testIdSuffix={postId}
			own={own}
		/>
	);
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
