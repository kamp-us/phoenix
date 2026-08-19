/**
 * fate-shaped post-detail header. The page derives `isAuthor` and passes it in;
 * the edit/delete affordances hang off it.
 */
import {useLiveView, type ViewRef, view} from "react-fate";
import type {Post} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {tagClass} from "../../lib/panoTags";
import {actorLabel} from "../moderation/actor-identity";
import {PostReactionBar} from "../reaction/PostReactionBar";
import {ReactionBarSlot} from "../reaction/ReactionBarSlot";
import {Tag, type TagKind} from "../ui/atoms";
import {Button} from "../ui/Button";
import {CopyLinkButton} from "../ui/CopyLinkButton";
import {EditedIndicator} from "../ui/EditedIndicator";
import {MetaRow} from "../ui/MetaRow";
import {ReportButton, type ReportOutcome} from "../ui/ReportButton";
import {ReviewBadge} from "../ui/ReviewBadge";
import {PostSaveButton, PostVoteWidget} from "./PanoPost";

/** Defined here, away from their widgets, so `PanoPost.tsx` needs no back-edge import. */
export const PostVoteView = view<Post>()({
	id: true,
	score: true,
	myVote: true,
});

export const PostSaveView = view<Post>()({
	id: true,
	isSaved: true,
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
	authorUsername: true,
	authorDisplayName: true,
	score: true,
	myVote: true,
	isSaved: true,
	commentCount: true,
	createdAt: true,
	updatedAt: true,
	sandboxed: true,
	tags: true,
	reactions: {counts: true, myReaction: true},
});

export interface PanoPostHeaderProps {
	post: ViewRef<"Post">;
	isAuthor: boolean;
	onEdit?: () => void;
	onDelete?: () => void;
	/** The page owns `report.submit` + the signed-out redirect. */
	onReport?: () => Promise<ReportOutcome>;
}

export function PanoPostHeader(props: PanoPostHeaderProps) {
	const post = useLiveView(PanoPostHeaderView, props.post);
	const tags = post.tags ?? [];
	return (
		<div>
			<h1 className="kp-pano-postpage__title kp-prose">
				{post.title}
				{/* `sandboxed` is already owner-scoped server-side; re-gated here on purpose (#2200). */}
				{props.isAuthor && post.sandboxed ? <ReviewBadge /> : null}
			</h1>
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
			<MetaRow className="kp-pano-postpage__meta">
				{tags.map((t, i) => (
					<Tag key={i} kind={tagClass(t.kind) as TagKind}>
						{t.label}
					</Tag>
				))}
				<span className="author">
					{actorLabel(post.authorDisplayName ?? null, post.authorUsername ?? null, post.author)}
				</span>
				<span>·</span>
				<span>{formatAgoTR(toIso(post.createdAt))}</span>
				<EditedIndicator createdAt={toIso(post.createdAt)} updatedAt={toIso(post.updatedAt)} />
				<span>·</span>
				<span>{post.commentCount} yorum</span>
				<span>·</span>
				<CopyLinkButton path={`/pano/${post.slug ?? post.id}`} testId="post-share" />
				<PostSaveButton postId={post.id} isSaved={post.isSaved ?? null} />
				{props.onReport ? <ReportButton onReport={props.onReport} testId="post-report" /> : null}
				{props.isAuthor ? (
					<>
						<Button
							type="button"
							variant="link"
							size="sm"
							data-testid="post-edit"
							onClick={props.onEdit}
						>
							düzenle
						</Button>
						<Button
							type="button"
							variant="link"
							size="sm"
							data-testid="post-delete"
							onClick={props.onDelete}
						>
							sil
						</Button>
					</>
				) : null}
			</MetaRow>
			{post.body ? (
				<div className="kp-pano-postpage__body kp-prose">
					{post.body.split(/\n{2,}/).map((para, i) => (
						<p key={i}>{renderMarkdownInline(para)}</p>
					))}
				</div>
			) : null}
			{/* Reactions live on the detail only, never the feed row (#2212). */}
			<ReactionBarSlot>
				<PostReactionBar postId={post.id} reactions={post.reactions} />
			</ReactionBarSlot>
		</div>
	);
}

export function PanoPostHeaderVote({
	post,
	isAuthor = false,
}: {
	post: ViewRef<"Post">;
	/** Viewer authored this post — visible but disabled (#2216). */
	isAuthor?: boolean;
}) {
	const data = useLiveView(PanoPostHeaderView, post);
	return (
		<PostVoteWidget
			postId={data.id}
			score={data.score}
			myVote={data.myVote ?? null}
			own={isAuthor}
		/>
	);
}
