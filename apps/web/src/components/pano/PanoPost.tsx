import {Button} from "@kampus/design";
import {useFateClient} from "react-fate";
import {useVoteFlash} from "../useVoteFlash";
import {VoteTriangle} from "../VoteTriangle";
import {PostSaveView, PostVoteView} from "./PanoPostHeader";
import {currentLocationReturnTo, useGatedToggle, useVoteToggle} from "./useVoteToggle";
import "./PanoPost.css";

/**
 * Presentational only — the parent owns the mutation + auth gate. On the viewer's
 * own content the control stays visible (stable feed geometry) but disabled: self
 * voting is blocked (#2216).
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
			<Button
				type="button"
				variant="outline"
				size="sm"
				iconOnly
				className="kp-pano-post__vote-btn"
				pressed={pressed}
				disabled={own}
				aria-label={own ? "Kendi gönderine oy veremezsin" : pressed ? "Oyunu geri al" : "Yukarı oy"}
				data-testid={testIdSuffix ? `post-vote-${testIdSuffix}` : undefined}
				onClick={() => onToggle?.()}
			>
				<VoteTriangle />
			</Button>
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

/** Optimistic writes go through `PostVoteView` keyed by `id` so every card referencing
 * this post re-renders. See `.patterns/fate-mutations-client.md`.
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
	/** Viewer authored this post — visible but disabled (#2216). */
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

export function PostSaveButton({postId, isSaved}: {postId: string; isSaved: boolean | null}) {
	const fate = useFateClient();

	const saved = isSaved === true;

	// A plain `isSaved` flip (no score floor), so it drives the shared gate directly
	// rather than the vote specialization.
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
		<Button
			type="button"
			variant="link"
			size="sm"
			className="kp-pano-post__save"
			pressed={saved}
			data-testid={`post-save-${postId}`}
			onClick={onToggle}
		>
			{saved ? "kaydedildi" : "kaydet"}
		</Button>
	);
}
