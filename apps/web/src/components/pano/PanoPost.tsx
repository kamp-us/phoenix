import {graphql, useMutation} from "react-relay";
import {Link, useNavigate} from "react-router";
import type {PanoPostRetractVoteMutation} from "../../__generated__/PanoPostRetractVoteMutation.graphql";
import type {PanoPostVoteMutation} from "../../__generated__/PanoPostVoteMutation.graphql";
import {useSession} from "../../auth/client";
import {authRedirectPath} from "../../lib/returnTo";
import {useSessionExpiredToast} from "../../lib/useSessionExpiredToast";
import {Tag, type TagKind} from "../ui/atoms";
import "./PanoPost.css";

/* Vote control — single triangle upvote with count below (lobsters-shape).
   Stays presentational; the parent owns the mutation + auth gate. */
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
	return (
		<div className="kp-pano-post__vote">
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
			<span
				className="kp-pano-post__vote-count"
				data-testid={testIdSuffix ? `post-score-${testIdSuffix}` : undefined}
			>
				{count}
			</span>
		</div>
	);
}

const PostVoteMutation = graphql`
  mutation PanoPostVoteMutation($postId: ID!) {
    voteOnPost(postId: $postId) {
      id
      score
      myVote
    }
  }
`;

const RetractPostVoteMutation = graphql`
  mutation PanoPostRetractVoteMutation($postId: ID!) {
    retractPostVote(postId: $postId) {
      id
      score
      myVote
    }
  }
`;

/**
 * Triangle vote button for a single post. Uses Relay's `optimisticResponse`
 * to flip both `myVote` and `score` synchronously on click — Relay merges the
 * response into the store keyed by `id`, so every card referencing this post
 * (feed list + detail page) re-renders instantly. On server error Relay rolls
 * back automatically. Mirrors `DefinitionCard.onVoteClick` (T5).
 *
 * Signed-out clicks navigate to `/auth?returnTo=<current>` rather than firing
 * the mutation — matches the pattern used across sözlük and the post submit
 * form (T4 / T5 / T7).
 */
export function PostVoteWidget({
	postId,
	score,
	myVote,
}: {
	postId: string;
	score: number;
	myVote: number | null;
}) {
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const [voteCommit, voteInFlight] = useMutation<PanoPostVoteMutation>(PostVoteMutation);
	const [retractCommit, retractInFlight] =
		useMutation<PanoPostRetractVoteMutation>(RetractPostVoteMutation);

	const inFlight = voteInFlight || retractInFlight;
	const voted = myVote === 1;

	const onToggle = () => {
		if (!session.data?.user) {
			navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));
			return;
		}
		if (inFlight) return;

		if (voted) {
			retractCommit({
				variables: {postId},
				optimisticResponse: {
					retractPostVote: {
						id: postId,
						score: Math.max(0, score - 1),
						myVote: null,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		} else {
			voteCommit({
				variables: {postId},
				optimisticResponse: {
					voteOnPost: {
						id: postId,
						score: score + 1,
						myVote: 1,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		}
	};

	return <VoteControl count={score} pressed={voted} onToggle={onToggle} testIdSuffix={postId} />;
}

export type PanoPostData = {
	id: string;
	rank?: number;
	title: string;
	href: string;
	url?: string;
	host?: string;
	tags?: {kind: TagKind; label: string; href?: string}[];
	author: string;
	agoLabel: string;
	commentCount: number;
	score: number;
	myVote?: -1 | 0 | 1;
};

export function PanoPost({
	post,
	onSave,
	onHide,
}: {
	post: PanoPostData;
	onSave?: (id: string) => void;
	onHide?: (id: string) => void;
}) {
	/* Site label — host in parens for external links, "yazı" for self-posts. */
	const siteLabel = post.host ?? (post.url ? null : "yazı");

	return (
		<article className="kp-pano-post">
			<span className="kp-pano-post__rank">
				{post.rank != null ? String(post.rank).padStart(2, "0") : ""}
			</span>
			<PostVoteWidget postId={post.id} score={post.score} myVote={post.myVote === 1 ? 1 : null} />
			<div className="kp-pano-post__body">
				<div className="kp-pano-post__title-row">
					{post.tags?.length ? (
						<span className="kp-pano-post__tags">
							{post.tags.map((t, i) => (
								<Tag key={i} kind={t.kind} href={t.href}>
									{t.label}
								</Tag>
							))}
						</span>
					) : null}
					<a className="kp-pano-post__title" href={post.url ?? post.href}>
						{post.title}
					</a>
					{post.host ? (
						<Link className="kp-pano-post__site" to={`/pano/site/${post.host}`}>
							{post.host}
						</Link>
					) : siteLabel ? (
						<span className="kp-pano-post__site">{siteLabel}</span>
					) : null}
				</div>
				<div className="kp-pano-post__meta">
					<span className="author">@{post.author}</span>
					<span className="dot">·</span>
					<span>{post.agoLabel}</span>
					<span className="dot">·</span>
					<a href={`${post.href}#comments`}>{post.commentCount} yorum</a>
					{onSave ? (
						<>
							<span className="dot">·</span>
							<button type="button" onClick={() => onSave(post.id)}>
								kaydet
							</button>
						</>
					) : null}
					{onHide ? (
						<>
							<span className="dot">·</span>
							<button type="button" onClick={() => onHide(post.id)}>
								gizle
							</button>
						</>
					) : null}
				</div>
			</div>
		</article>
	);
}

export function PanoPostList({
	posts,
	onSave,
	onHide,
}: {
	posts: PanoPostData[];
	onSave?: (id: string) => void;
	onHide?: (id: string) => void;
}) {
	return (
		<div className="kp-pano-list">
			{posts.map((p) => (
				<PanoPost key={p.id} post={p} onSave={onSave} onHide={onHide} />
			))}
		</div>
	);
}
