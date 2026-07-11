/**
 * View-shaped tree node for the post-detail comment thread. The page assembles
 * the `parentId` → children map and hands each node its children array, so a
 * level renders its subtree without re-walking the flat connection.
 */
import * as React from "react";
import {useFateClient, useLiveView, type ViewRef, view} from "react-fate";
import type {Comment} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {actorLabel} from "../moderation/actor-identity";
import {CommentReactionBar} from "../reaction/CommentReactionBar";
import {ReactionBarSlot} from "../reaction/ReactionBarSlot";
import {CopyLinkButton} from "../ui/CopyLinkButton";
import {EditedIndicator} from "../ui/EditedIndicator";
import {Menu} from "../ui/Menu";
import {ReportButton, type ReportOutcome} from "../ui/ReportButton";
import {useVoteFlash} from "../useVoteFlash";
import {VoteTriangle} from "../VoteTriangle";
import {currentLocationReturnTo, useVoteToggle} from "./useVoteToggle";
import "./PanoComment.css";

export const CommentTreeNodeView = view<Comment>()({
	id: true,
	parentId: true,
	body: true,
	score: true,
	myVote: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	author: true,
	authorId: true,
	authorUsername: true,
	authorDisplayName: true,
	reactions: {counts: true, myReaction: true},
});

/**
 * Write-back view for a comment vote. Masking is by view identity, so the
 * write-back must reuse a view the node ref carries — `CommentTreeNodeView`
 * already selects these fields, so we reuse it.
 */
const CommentVoteView = CommentTreeNodeView;

export interface CommentTreeNodeProps {
	comment: ViewRef<"Comment">;
	/** Parent post's canonical path (`/pano/:slug`); the node appends the `#comment-<id>` anchor. */
	postPath: string;
	/** Direct children, already filtered + ordered by the page. */
	children: ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
	/** comment id → its children list, for resolving grandchildren in recursion. */
	childrenForId: (id: string) => ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
	depth?: number;
	/** Comment id the URL hash currently targets — that node renders highlighted. */
	activeCommentId?: string | null;
	currentUserId: string | null;
	onReply?: (id: string) => void;
	onEdit?: (id: string) => void;
	onDelete?: (id: string) => void;
	/** Reports this comment; the page owns `report.submit` + the signed-out redirect. */
	onReport?: (id: string) => Promise<ReportOutcome>;
	/** comment id → its own composers, so the root node is not a special case. */
	composerFor: (id: string) => {
		replyComposer?: React.ReactNode;
		editComposer?: React.ReactNode;
	};
}

export function CommentTreeNode(props: CommentTreeNodeProps) {
	const data = useLiveView(CommentTreeNodeView, props.comment);
	const fate = useFateClient();
	const {onReport} = props;
	const {replyComposer, editComposer} = props.composerFor(data.id);
	const localId = data.id;
	const [open, setOpen] = React.useState(true);

	const isDeleted = data.deletedAt != null;
	const isOwner =
		!isDeleted && props.currentUserId != null && data.authorId === props.currentUserId;
	const voted = data.myVote === true;
	const score = data.score;
	const {flashing, endFlash} = useVoteFlash(score);
	const editing = editComposer != null;

	const highlight = props.activeCommentId === data.id;
	const cls = ["kp-comment", highlight ? "kp-comment--highlighted" : ""].filter(Boolean).join(" ");

	const onUpvote = useVoteToggle({
		voted,
		score,
		returnTo: currentLocationReturnTo,
		mutations: {
			vote: (optimistic) =>
				fate.mutations.comment.vote({input: {id: data.id}, optimistic, view: CommentVoteView}),
			retractVote: (optimistic) =>
				fate.mutations.comment.retractVote({
					input: {id: data.id},
					optimistic,
					view: CommentVoteView,
				}),
		},
	});

	return (
		<article className={cls} id={`comment-${data.id}`}>
			<header className="kp-comment__head">
				{isDeleted ? (
					<span className="kp-comment__author kp-comment__author--deleted">[silindi]</span>
				) : (
					// Live author identity via `actorLabel` (#2139): current displayName → @username,
					// falling back to the write-time `author` snapshot for an unstamped/legacy row.
					// The profile link targets the live username when present, else the snapshot.
					<a className="kp-comment__author" href={`/u/${data.authorUsername ?? data.author}`}>
						{actorLabel(data.authorDisplayName ?? null, data.authorUsername ?? null, data.author)}
					</a>
				)}
				<span>{formatAgoTR(toIso(data.createdAt))}</span>
				<EditedIndicator createdAt={toIso(data.createdAt)} updatedAt={toIso(data.updatedAt)} />
				{!isDeleted ? (
					<button
						type="button"
						className={`kp-comment__upvote ${voted ? "kp-comment__upvote--active" : ""}`}
						aria-pressed={voted}
						aria-label={voted ? "Oyunu geri al" : "Yukarı oy"}
						onClick={onUpvote}
						data-testid={`comment-vote-${localId}`}
					>
						<VoteTriangle />{" "}
						<span
							className={flashing ? "kp-vote-flash" : undefined}
							onAnimationEnd={endFlash}
							data-testid={`comment-score-${localId}`}
						>
							{score}
						</span>
					</button>
				) : null}
				<button
					type="button"
					className="kp-comment__collapser"
					onClick={() => setOpen(!open)}
					aria-label={open ? "Daralt" : "Genişlet"}
				>
					[ {open ? "—" : "+"} ]
				</button>
			</header>
			{open ? (
				<>
					{editing ? (
						<div className="kp-comment__edit" data-testid={`pano-comment-edit-${localId}`}>
							{editComposer}
						</div>
					) : (
						<div className="kp-comment__body kp-prose">
							{data.body.split(/\n{2,}/).map((para, i) => (
								<p key={i}>{renderMarkdownInline(para)}</p>
							))}
						</div>
					)}
					{!isDeleted && !editing ? (
						<footer className="kp-comment__foot">
							<button
								type="button"
								onClick={() => props.onReply?.(data.id)}
								data-testid={`pano-comment-reply-trigger-${localId}`}
							>
								yanıtla
							</button>
							<CopyLinkButton
								path={`${props.postPath}#comment-${data.id}`}
								testId={`pano-comment-share-${localId}`}
							/>
							{onReport ? (
								<ReportButton
									onReport={() => onReport(data.id)}
									testId={`pano-comment-report-${localId}`}
								/>
							) : null}
							{isOwner ? (
								<Menu.Root>
									<Menu.Trigger
										className="kp-comment__menu-trigger"
										aria-label="Daha fazla"
										data-testid={`pano-comment-menu-${localId}`}
									>
										⋯
									</Menu.Trigger>
									<Menu.Popup align="start">
										<Menu.Item
											onClick={() => props.onEdit?.(data.id)}
											data-testid={`pano-comment-edit-trigger-${localId}`}
										>
											düzenle
										</Menu.Item>
										<Menu.Separator />
										<Menu.Item
											danger
											onClick={() => props.onDelete?.(data.id)}
											data-testid={`pano-comment-delete-trigger-${localId}`}
										>
											sil
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							) : null}
						</footer>
					) : null}
					{!isDeleted && !editing ? (
						<ReactionBarSlot>
							<CommentReactionBar commentId={data.id} reactions={data.reactions} />
						</ReactionBarSlot>
					) : null}
					{replyComposer ? (
						<div className="kp-comment__reply" data-testid={`pano-comment-reply-${localId}`}>
							{replyComposer}
						</div>
					) : null}
					{props.children.length ? (
						<div className="kp-comment__children">
							{props.children.map((child) => (
								<CommentTreeNode
									key={child.id}
									comment={child.ref}
									postPath={props.postPath}
									children={props.childrenForId(child.id)}
									childrenForId={props.childrenForId}
									depth={(props.depth ?? 0) + 1}
									activeCommentId={props.activeCommentId}
									currentUserId={props.currentUserId}
									onReply={props.onReply}
									onEdit={props.onEdit}
									onDelete={props.onDelete}
									onReport={props.onReport}
									composerFor={props.composerFor}
								/>
							))}
						</div>
					) : null}
				</>
			) : null}
		</article>
	);
}
