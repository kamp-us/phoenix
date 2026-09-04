/**
 * View-shaped tree node for the post-detail comment thread. The page hands each
 * node its children, so a level renders its subtree without re-walking the
 * flat connection.
 */

import {
	Button,
	CopyLinkButton,
	EditedIndicator,
	Menu,
	ReportButton,
	type ReportOutcome,
	SandboxMarker,
} from "@kampus/design";
import * as React from "react";
import {useFateClient, useLiveView, type ViewRef, view} from "react-fate";
import type {Comment} from "../../../worker/features/fate/views";
import {toIso} from "../../fate/wire";
import {useT} from "../../i18n";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {actorLabel} from "../moderation/actor-identity";
import {CommentReactionBar} from "../reaction/CommentReactionBar";
import {ReactionBarSlot} from "../reaction/ReactionBarSlot";
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
	sandboxed: true,
	sandboxedInPlace: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	author: true,
	authorId: true,
	authorUsername: true,
	authorDisplayName: true,
	reactions: {counts: true, myReaction: true},
});

/** Masking is by view identity, so the write-back must reuse the node's own view. */
const CommentVoteView = CommentTreeNodeView;

export interface CommentTreeNodeProps {
	comment: ViewRef<"Comment">;
	/** `/pano/:slug` — the node appends the `#comment-<id>` anchor. */
	postPath: string;
	/** Already filtered + ordered by the page. */
	children: ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
	childrenForId: (id: string) => ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
	depth?: number;
	/** The URL hash's target — that node renders highlighted. */
	activeCommentId?: string | null;
	currentUserId: string | null;
	onReply?: (id: string) => void;
	onEdit?: (id: string) => void;
	onDelete?: (id: string) => void;
	/** The page owns `report.submit` + the signed-out redirect. */
	onReport?: (id: string) => Promise<ReportOutcome>;
	/** Per-id, so the root node is not a special case. */
	composerFor: (id: string) => {
		replyComposer?: React.ReactNode;
		editComposer?: React.ReactNode;
	};
}

export function CommentTreeNode(props: CommentTreeNodeProps) {
	const t = useT();
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
					<span className="kp-comment__author kp-comment__author--deleted">
						{t("pano.comment.deleted")}
					</span>
				) : (
					<a className="kp-comment__author" href={`/u/${data.authorUsername ?? data.author}`}>
						{actorLabel(data.authorDisplayName ?? null, data.authorUsername ?? null, data.author)}
					</a>
				)}
				{/* The node's one sandbox badge (#6427): the owner's "incelemede" (#4282, re-gated
				    on `isOwner`), else the reader-facing çaylak marker (#6425). Same shape as
				    `PanoPostHeader` / `PanoPostCard` / `DefinitionCard`. */}
				<SandboxMarker
					isOwn={isOwner}
					sandboxed={data.sandboxed}
					sandboxedInPlace={data.sandboxedInPlace}
				/>
				<span>{formatAgoTR(toIso(data.createdAt))}</span>
				<EditedIndicator createdAt={toIso(data.createdAt)} updatedAt={toIso(data.updatedAt)} />
				{!isDeleted ? (
					<Button
						type="button"
						variant="tertiary"
						size="sm"
						className={`kp-comment__upvote ${voted ? "kp-comment__upvote--active" : ""}`}
						pressed={voted}
						aria-label={voted ? t("pano.vote.retract") : t("pano.vote.up")}
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
					</Button>
				) : null}
				<Button
					type="button"
					variant="link"
					size="sm"
					className="kp-comment__collapser"
					onClick={() => setOpen(!open)}
					aria-label={open ? t("pano.comment.collapse") : t("pano.comment.expand")}
				>
					[ {open ? "—" : "+"} ]
				</Button>
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
							<Button
								type="button"
								variant="link"
								size="sm"
								onClick={() => props.onReply?.(data.id)}
								data-testid={`pano-comment-reply-trigger-${localId}`}
							>
								{t("pano.action.reply")}
							</Button>
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
								<Menu
									placement="bottom-start"
									trigger={
										<Button
											type="button"
											variant="tertiary"
											size="sm"
											iconOnly
											className="kp-comment__menu-trigger"
											aria-label={t("pano.comment.more")}
											data-testid={`pano-comment-menu-${localId}`}
										>
											⋯
										</Button>
									}
									items={[
										{
											value: "edit",
											label: (
												<span data-testid={`pano-comment-edit-trigger-${localId}`}>
													{t("pano.action.edit")}
												</span>
											),
										},
										{type: "separator"},
										{
											value: "delete",
											label: (
												<span
													className="kp-menu-danger"
													data-testid={`pano-comment-delete-trigger-${localId}`}
												>
													{t("pano.action.delete")}
												</span>
											),
										},
									]}
									onSelect={(value) => {
										if (value === "edit") props.onEdit?.(data.id);
										if (value === "delete") props.onDelete?.(data.id);
									}}
								/>
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
