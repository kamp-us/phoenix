import {useState} from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {codeOf} from "../../fate/wire";
import {authRedirectPath} from "../../lib/returnTo";
import {Tag, type TagKind} from "../ui/atoms";
import {PostSaveView, PostVoteView} from "./PanoPostHeader";
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
	const session = useSession();
	const navigate = useNavigate();
	const [inFlight, setInFlight] = useState(false);

	const voted = myVote === 1;

	const redirectToAuth = () =>
		navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));

	const onToggle = async () => {
		if (!session.data?.user) {
			redirectToAuth();
			return;
		}
		if (inFlight) return;
		setInFlight(true);
		try {
			if (voted) {
				await fate.mutations.post.retractVote({
					input: {id: postId},
					optimistic: {score: Math.max(0, score - 1), myVote: null},
					view: PostVoteView,
				});
			} else {
				await fate.mutations.post.vote({
					input: {id: postId},
					optimistic: {score: score + 1, myVote: 1},
					view: PostVoteView,
				});
			}
		} catch (error) {
			if (codeOf(error) === "UNAUTHORIZED") redirectToAuth();
		} finally {
			setInFlight(false);
		}
	};

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
	const session = useSession();
	const navigate = useNavigate();
	const [inFlight, setInFlight] = useState(false);

	const saved = isSaved === true;

	const redirectToAuth = () =>
		navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));

	const onToggle = async () => {
		if (!session.data?.user) {
			redirectToAuth();
			return;
		}
		if (inFlight) return;
		setInFlight(true);
		try {
			if (saved) {
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
		} catch (error) {
			if (codeOf(error) === "UNAUTHORIZED") redirectToAuth();
		} finally {
			setInFlight(false);
		}
	};

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
