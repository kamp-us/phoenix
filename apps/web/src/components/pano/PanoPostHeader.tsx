/**
 * fate-shaped post-detail header. The page derives `isAuthor` and passes it in;
 * the edit/delete affordances hang off it.
 */

import {
	Button,
	CopyLinkButton,
	EditedIndicator,
	MetaRow,
	ReportButton,
	type ReportOutcome,
	SandboxMarker,
	Tag,
	type TagKind,
} from "@kampus/design";
import {useLiveView, type ViewRef, view} from "react-fate";
import type {Post} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {useLocale} from "../../i18n";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {tagClass} from "../../lib/panoTags";
import {actorLabel} from "../moderation/actor-identity";
import {PostReactionBar} from "../reaction/PostReactionBar";
import {ReactionBarSlot} from "../reaction/ReactionBarSlot";
import {commentCountLabel} from "./commentCount";
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
	sandboxedInPlace: true,
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
	const {locale, t} = useLocale();
	const post = useLiveView(PanoPostHeaderView, props.post);
	const tags = post.tags ?? [];
	return (
		<div>
			<h1 className="kp-pano-postpage__title kp-prose">
				{post.title}
				{/* The item's one sandbox badge (#6427): the author's own "incelemede" (#2200,
				    re-gated on `isAuthor` since `sandboxed` is owner-scoped server-side), else the
				    reader-facing çaylak marker (#6425) on somebody else's hazırlık-stage post. */}
				<SandboxMarker
					isOwn={props.isAuthor}
					sandboxed={post.sandboxed}
					sandboxedInPlace={post.sandboxedInPlace}
				/>
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
				<span>{commentCountLabel(t, locale, post.commentCount)}</span>
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
							{t("pano.action.edit")}
						</Button>
						<Button
							type="button"
							variant="link"
							size="sm"
							data-testid="post-delete"
							onClick={props.onDelete}
						>
							{t("pano.action.delete")}
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
