/**
 * fate-shaped post-detail header. The detail page spreads `PanoPostHeaderView`
 * into `PostDetailView` and hands the `Post` ref down. Edit/delete affordances
 * are gated by `isAuthor`, which the page derives and passes in.
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
 * Write-back view for a post vote. Defined here rather than next to
 * `PostVoteWidget` (in `PanoPost.tsx`) to keep that module free of a back-edge
 * import to the header.
 */
export const PostVoteView = view<Post>()({
	id: true,
	score: true,
	myVote: true,
});

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
			<h1 className="kp-pano-postpage__title kp-prose">{post.title}</h1>
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
				<div className="kp-pano-postpage__body kp-prose">
					{post.body.split(/\n{2,}/).map((para, i) => (
						<p key={i}>{renderMarkdownInline(para)}</p>
					))}
				</div>
			) : null}
		</div>
	);
}

export function PanoPostHeaderVote({post}: {post: ViewRef<"Post">}) {
	const data = useLiveView(PanoPostHeaderView, post);
	return <PostVoteWidget postId={data.id} score={data.score} myVote={data.myVote ?? null} />;
}
