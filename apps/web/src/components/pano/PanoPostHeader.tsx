/**
 * fate-shaped post-detail header.
 *
 * Reads its data via `useView(PanoPostHeaderView, ref)` — the detail page spreads
 * `PanoPostHeaderView` into its `post` request item (`PostDetailView`) and hands
 * the `Post` ref down. The header declares what it needs; fate masks the rest.
 *
 * Edit / delete affordances are gated by `isAuthor`, which the page derives from
 * the session and passes in.
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import type {Post} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {Tag, type TagKind} from "../ui/atoms";
import {EditedIndicator} from "../ui/EditedIndicator";
import {PostVoteWidget} from "./PanoPost";

/**
 * The minimal write-back view for a post vote — the shape
 * `fate.mutations.post.{vote,retractVote}` returns and normalizes into the cache
 * keyed by `id`. Co-located with `PostVoteWidget` (in `PanoPost.tsx`) but defined
 * here to keep the vote widget's import free of a back-edge to the header.
 */
export const PostVoteView = view<Post>()({
	id: true,
	score: true,
	myVote: true,
});

/** The fields the post-detail header reads. Co-located with the component. */
export const PanoPostHeaderView = view<Post>()({
	id: true,
	slug: true,
	title: true,
	url: true,
	host: true,
	body: true,
	author: true,
	authorId: true,
	score: true,
	myVote: true,
	commentCount: true,
	createdAt: true,
	updatedAt: true,
	tags: true,
});

export interface PanoPostHeaderProps {
	post: ViewRef<"Post">;
	isAuthor: boolean;
	onEdit?: () => void;
	onDelete?: () => void;
}

export function PanoPostHeader(props: PanoPostHeaderProps) {
	const post = useLiveView(PanoPostHeaderView, props.post);
	const tags = post.tags ?? [];
	return (
		<div>
			<h1 className="kp-pano-postpage__title">{post.title}</h1>
			{post.url ? (
				<a
					className="kp-pano-postpage__url"
					href={post.url}
					target="_blank"
					rel="noreferrer noopener"
				>
					{post.host ?? post.url} ↗
				</a>
			) : null}
			<div className="kp-pano-postpage__meta">
				{tags.map((t, i) => (
					<Tag key={i} kind={t.kind as TagKind}>
						{t.label}
					</Tag>
				))}
				<span className="author">@{post.author}</span>
				<span>·</span>
				<span>{formatAgoTR(toIso(post.createdAt))}</span>
				<EditedIndicator createdAt={toIso(post.createdAt)} updatedAt={toIso(post.updatedAt)} />
				<span>·</span>
				<span>{post.commentCount} yorum</span>
				<span>·</span>
				<button type="button">paylaş</button>
				<button type="button">kaydet</button>
				<button type="button">bildir</button>
				{props.isAuthor ? (
					<>
						<button type="button" data-testid="post-edit" onClick={props.onEdit}>
							düzenle
						</button>
						<button type="button" data-testid="post-delete" onClick={props.onDelete}>
							sil
						</button>
					</>
				) : null}
			</div>
			{post.body ? (
				<div className="kp-pano-postpage__body">
					{post.body.split(/\n{2,}/).map((para, i) => (
						<p key={i}>{renderMarkdownInline(para)}</p>
					))}
				</div>
			) : null}
		</div>
	);
}

/** Convenience accessor — the detail page reads the score/myVote/id for the vote widget. */
export function PanoPostHeaderVote({post}: {post: ViewRef<"Post">}) {
	const data = useLiveView(PanoPostHeaderView, post);
	return <PostVoteWidget postId={data.id} score={data.score} myVote={data.myVote ?? null} />;
}
