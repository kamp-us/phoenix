/**
 * Fragment-shaped tree node for the post-detail comment thread.
 * Replaces the prop-shaped `PanoComment` from the MVP.
 *
 * Each node declares `CommentTreeNodeFragment on Comment` and reads via
 * `useFragment` — pages spread `<CommentTreeNode comment={edge.node} />`
 * (a fragment ref) instead of shaping the row into props. Replies recurse
 * by spreading the same fragment again.
 *
 * The flat connection edges land in the page; the page assembles the
 * `parentId` → children map and hands a node + its children array down so
 * each level renders its own subtree without re-walking the whole list.
 */
import * as React from "react";
import {graphql, useFragment, useMutation} from "react-relay";
import {useNavigate} from "react-router";
import type {CommentTreeNodeFragment$key} from "../../__generated__/CommentTreeNodeFragment.graphql";
import type {CommentTreeNodeRetractVoteMutation} from "../../__generated__/CommentTreeNodeRetractVoteMutation.graphql";
import type {CommentTreeNodeVoteMutation} from "../../__generated__/CommentTreeNodeVoteMutation.graphql";
import {useSession} from "../../auth/client";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {authRedirectPath} from "../../lib/returnTo";
import {useSessionExpiredToast} from "../../lib/useSessionExpiredToast";
import {extractLocalId} from "../../relay/encodeNodeId";
import {EditedIndicator} from "../ui/EditedIndicator";
import {Menu} from "../ui/Menu";
import "./PanoComment.css";

const CommentTreeNodeFragmentDef = graphql`
	fragment CommentTreeNodeFragment on Comment {
		id
		parentId
		body
		score
		myVote
		createdAt
		updatedAt
		deletedAt
		author
		authorId
	}
`;

/**
 * Cast an upvote on a comment. Returns the
 * updated `score` + `myVote` so Relay's automatic store update merges the
 * scalar values into the existing `Comment:<id>` record — no refetch.
 */
const CommentVoteMutation = graphql`
	mutation CommentTreeNodeVoteMutation($commentId: ID!) {
		voteOnComment(commentId: $commentId) {
			id
			score
			myVote
		}
	}
`;

const CommentRetractVoteMutation = graphql`
	mutation CommentTreeNodeRetractVoteMutation($commentId: ID!) {
		retractCommentVote(commentId: $commentId) {
			id
			score
			myVote
		}
	}
`;

export interface CommentTreeNodeProps {
	/** Fragment ref into a Comment row. */
	comment: CommentTreeNodeFragment$key;
	/**
	 * Direct children of this node — already filtered + ordered by the page.
	 * Each child is itself an array entry in `childrenForId` so the recursion
	 * can lookup grandchildren without re-walking.
	 */
	children: ReadonlyArray<{id: string; ref: CommentTreeNodeFragment$key}>;
	/** Lookup by comment id → its own children list (for grandchildren). */
	childrenForId: (id: string) => ReadonlyArray<{id: string; ref: CommentTreeNodeFragment$key}>;
	depth?: number;
	hash?: string;
	highlight?: boolean;
	/** Optional inline reply composer rendered right after the body. */
	replyComposer?: React.ReactNode;
	/** Optional inline edit composer rendered IN PLACE OF the static body. */
	editComposer?: React.ReactNode;
	currentUserId: string | null;
	onReply?: (id: string) => void;
	onEdit?: (id: string) => void;
	onDelete?: (id: string) => void;
	/** Lookup helper — page maps comment id → its own composers. */
	composerFor?: (id: string) => {
		replyComposer?: React.ReactNode;
		editComposer?: React.ReactNode;
	};
}

export function CommentTreeNode(props: CommentTreeNodeProps) {
	const data = useFragment(CommentTreeNodeFragmentDef, props.comment);
	// Test affordances key off the local comment id (e.g. `comm_<ulid>`),
	// not the Relay global id; keep testids stable + human-readable.
	const localId = extractLocalId(data.id, "Comment");
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const [open, setOpen] = React.useState(true);
	const [voteCommit, voteInFlight] = useMutation<CommentTreeNodeVoteMutation>(CommentVoteMutation);
	const [retractCommit, retractInFlight] = useMutation<CommentTreeNodeRetractVoteMutation>(
		CommentRetractVoteMutation,
	);

	const isDeleted = data.deletedAt != null;
	const isOwner =
		!isDeleted && props.currentUserId != null && data.authorId === props.currentUserId;
	const voted = (data.myVote ?? 0) === 1;
	const score = data.score;
	const inFlight = voteInFlight || retractInFlight;
	const editing = props.editComposer != null;

	const cls = [
		"kp-comment",
		props.depth === 1 ? "kp-comment--depth-1" : "",
		(props.depth ?? 0) >= 2 ? "kp-comment--depth-2" : "",
		props.highlight ? "kp-comment--highlighted" : "",
	]
		.filter(Boolean)
		.join(" ");

	const onUpvote = () => {
		if (!session.data?.user) {
			navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));
			return;
		}
		if (inFlight) return;
		if (voted) {
			retractCommit({
				variables: {commentId: data.id},
				optimisticResponse: {
					retractCommentVote: {
						id: data.id,
						score: Math.max(0, score - 1),
						myVote: null,
					},
				},
				onCompleted: (_d, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					if (handleAuthError(null, err)) return;
					console.warn("[pano] retract comment vote failed", err);
				},
			});
		} else {
			voteCommit({
				variables: {commentId: data.id},
				optimisticResponse: {
					voteOnComment: {
						id: data.id,
						score: score + 1,
						myVote: 1,
					},
				},
				onCompleted: (_d, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					if (handleAuthError(null, err)) return;
					console.warn("[pano] vote on comment failed", err);
				},
			});
		}
	};

	return (
		<article className={cls} id={props.hash}>
			<header className="kp-comment__head">
				{isDeleted ? (
					<span className="kp-comment__author kp-comment__author--deleted">[silindi]</span>
				) : (
					<a className="kp-comment__author" href={`/u/${data.author}`}>
						@{data.author}
					</a>
				)}
				<span>{formatAgoTR(data.createdAt)}</span>
				<EditedIndicator createdAt={data.createdAt} updatedAt={data.updatedAt} />
				{!isDeleted ? (
					<button
						type="button"
						className={`kp-comment__upvote ${voted ? "kp-comment__upvote--active" : ""}`}
						aria-pressed={voted}
						aria-label="Yukarı oy"
						onClick={onUpvote}
						data-testid={`comment-vote-${localId}`}
					>
						<span className="triangle" />{" "}
						<span data-testid={`comment-score-${localId}`}>{score}</span>
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
							{props.editComposer}
						</div>
					) : (
						<div className="kp-comment__body">
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
							<button type="button">paylaş</button>
							<button type="button">bildir</button>
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
										<Menu.Item>kalıcı bağlantı</Menu.Item>
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
					{props.replyComposer ? (
						<div className="kp-comment__reply" data-testid={`pano-comment-reply-${localId}`}>
							{props.replyComposer}
						</div>
					) : null}
					{props.children.length ? (
						<div>
							{props.children.map((child) => {
								const c = props.composerFor?.(child.id);
								return (
									<CommentTreeNode
										key={child.id}
										comment={child.ref}
										children={props.childrenForId(child.id)}
										childrenForId={props.childrenForId}
										depth={(props.depth ?? 0) + 1}
										currentUserId={props.currentUserId}
										onReply={props.onReply}
										onEdit={props.onEdit}
										onDelete={props.onDelete}
										composerFor={props.composerFor}
										replyComposer={c?.replyComposer}
										editComposer={c?.editComposer}
									/>
								);
							})}
						</div>
					) : null}
				</>
			) : null}
		</article>
	);
}
