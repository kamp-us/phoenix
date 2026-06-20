import {useFateClient} from "react-fate";
import {Link} from "react-router";
import {Tag, type TagKind} from "../ui/atoms";
import {PostSaveView, PostVoteView} from "./PanoPostHeader";
import {currentLocationReturnTo, useGatedToggle, useVoteToggle} from "./useVoteToggle";
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
	myVote: number | null;
}) {
	const fate = useFateClient();

	const voted = myVote === 1;

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
	isSaved?: boolean | null;
};

export function PanoPost({post, onHide}: {post: PanoPostData; onHide?: (id: string) => void}) {
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
					<a className="kp-pano-post__title kp-prose" href={post.url ?? post.href}>
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
					<span className="dot">·</span>
					<PostSaveButton postId={post.id} isSaved={post.isSaved ?? null} />
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
	onHide,
}: {
	posts: PanoPostData[];
	onHide?: (id: string) => void;
}) {
	return (
		<div className="kp-pano-list">
			{posts.map((p) => (
				<PanoPost key={p.id} post={p} onHide={onHide} />
			))}
		</div>
	);
}
