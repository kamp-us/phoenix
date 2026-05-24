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
import {useFateClient, useLiveView, type ViewRef, view} from "react-fate";
import {useNavigate} from "react-router";
import type {Comment} from "../../../worker/fate/views";
import {useSession} from "../../auth/client";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline} from "../../lib/markdown";
import {decodeMutationErrorCode} from "../../lib/mutationErrorCodes";
import {authRedirectPath} from "../../lib/returnTo";
import {EditedIndicator} from "../ui/EditedIndicator";
import {Menu} from "../ui/Menu";
import "./PanoComment.css";

/** The fields a comment tree node reads. Co-located with the component. */
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
});

/**
 * The minimal write-back view for a comment vote — the shape
 * `fate.mutations.comment.{vote,retractVote}` returns and normalizes keyed by
 * `id`. Spread into `CommentTreeNodeView` so a vote write re-renders the node in
 * place. (Vote is a same-`Comment` field mutation; masking is by view identity,
 * so a view the node ref carries must be used — `CommentTreeNodeView` already
 * selects these fields, so we reuse it as the write-back view.)
 */
const CommentVoteView = CommentTreeNodeView;

/** Wire dates arrive as strings though the entity type says `Date`. */
const toIso = (value: Date | string | null | undefined): string =>
	value == null ? "" : value instanceof Date ? value.toISOString() : String(value);

/** Read the `.code` off a thrown / returned fate error. */
const codeOf = (error: unknown): string =>
	error &&
	typeof error === "object" &&
	"code" in error &&
	typeof (error as {code: unknown}).code === "string"
		? (decodeMutationErrorCode((error as {code: string}).code) ?? "INTERNAL_SERVER_ERROR")
		: "INTERNAL_SERVER_ERROR";

export interface CommentTreeNodeProps {
	/** View ref into a Comment node from the post's comments connection. */
	comment: ViewRef<"Comment">;
	/**
	 * Direct children of this node — already filtered + ordered by the page.
	 * Each child is itself an array entry in `childrenForId` so the recursion
	 * can lookup grandchildren without re-walking.
	 */
	children: ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
	/** Lookup by comment id → its own children list (for grandchildren). */
	childrenForId: (id: string) => ReadonlyArray<{id: string; ref: ViewRef<"Comment">}>;
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
	// Live: a comment vote/edit on another client publishes
	// `live.update("Comment", id, …)` with the re-resolved node inline, so the
	// score/body re-render here without a refetch.
	const data = useLiveView(CommentTreeNodeView, props.comment);
	const fate = useFateClient();
	// Test affordances key off the raw comment id (`comm_<ulid>`) — on fate the
	// id is already the raw per-type id (no Relay global-id unwrap needed).
	const localId = data.id;
	const session = useSession();
	const navigate = useNavigate();
	const [open, setOpen] = React.useState(true);
	const [inFlight, setInFlight] = React.useState(false);

	const isDeleted = data.deletedAt != null;
	const isOwner =
		!isDeleted && props.currentUserId != null && data.authorId === props.currentUserId;
	const voted = (data.myVote ?? 0) === 1;
	const score = data.score;
	const editing = props.editComposer != null;

	const cls = [
		"kp-comment",
		props.depth === 1 ? "kp-comment--depth-1" : "",
		(props.depth ?? 0) >= 2 ? "kp-comment--depth-2" : "",
		props.highlight ? "kp-comment--highlighted" : "",
	]
		.filter(Boolean)
		.join(" ");

	const redirectToAuth = () =>
		navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));

	const onUpvote = async () => {
		if (!session.data?.user) {
			redirectToAuth();
			return;
		}
		if (inFlight) return;
		setInFlight(true);
		try {
			if (voted) {
				await fate.mutations.comment.retractVote({
					input: {id: data.id},
					optimistic: {score: Math.max(0, score - 1), myVote: null},
					view: CommentVoteView,
				});
			} else {
				await fate.mutations.comment.vote({
					input: {id: data.id},
					optimistic: {score: score + 1, myVote: 1},
					view: CommentVoteView,
				});
			}
		} catch (error) {
			// Boundary-class throw (1.0.3 classifies phoenix codes as boundary); the
			// optimistic flip already rolled back. Surface UNAUTHORIZED as a redirect;
			// the vote button has no inline slot, so stay silent otherwise.
			if (codeOf(error) === "UNAUTHORIZED") redirectToAuth();
		} finally {
			setInFlight(false);
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
				<span>{formatAgoTR(toIso(data.createdAt))}</span>
				<EditedIndicator createdAt={toIso(data.createdAt)} updatedAt={toIso(data.updatedAt)} />
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
