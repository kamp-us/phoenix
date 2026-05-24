import {useState} from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {decodeMutationErrorCode} from "../../lib/mutationErrorCodes";
import {authRedirectPath} from "../../lib/returnTo";
import {Tag, type TagKind} from "../ui/atoms";
import {PostVoteView} from "./PanoPostHeader";
import "./PanoPost.css";

/** Read the `.code` off a thrown / returned fate error (the boundary-class */
/** throw already rolled back optimism — see `.patterns/fate-mutations-client.md`). */
const codeOf = (error: unknown): string =>
	error &&
	typeof error === "object" &&
	"code" in error &&
	typeof (error as {code: unknown}).code === "string"
		? (decodeMutationErrorCode((error as {code: string}).code) ?? "INTERNAL_SERVER_ERROR")
		: "INTERNAL_SERVER_ERROR";

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

/**
 * Triangle vote button for a single post — fate.
 *
 * Dispatches `fate.mutations.post.{vote,retractVote}` with a declarative
 * `optimistic` flip of `score` + `myVote`. The result is written back through
 * `PostVoteView` keyed by `id`, so every card referencing this post (feed list +
 * detail page) re-renders instantly; the optimistic write rolls back on error.
 *
 * Signed-out clicks navigate to `/auth?returnTo=<current>` rather than firing
 * the mutation. Error routing follows the 1.0.3 call-site-catch pattern (phoenix
 * codes classify as boundary, so the mutation throws; the optimistic flip already
 * rolled back). The vote button has no inline error slot, so we surface only
 * `UNAUTHORIZED` (→ auth redirect) and stay silent otherwise.
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
