/**
 * Post-detail page — fate.
 *
 * One batched `useRequest({post: {view: PostDetailView, args:{idOrSlug,
 * comments:{first}}}})` resolves the header + first page of comments with no
 * waterfall. `post` is the `queries.post` client root; the nested `comments`
 * connection rides on the `Post` view, delivered inline by the resolver (see
 * `.patterns/fate-connections.md`). `PostDetailView` spreads `PanoPostHeaderView`
 * (the header's view) and adds the `comments` connection whose node is
 * `CommentTreeNodeView`. Children mask their slice off the same refs.
 *
 * Mutations (`fate.mutations.{post,comment}.*`):
 *  - post vote — on `PostVoteWidget` (optimistic, in `PanoPost.tsx`).
 *  - post edit — `post.edit` writes the new title/body back through
 *    `PanoPostHeaderView` (optimistic, re-renders in place).
 *  - post delete — `post.delete` returns the deleted id; we navigate back to /pano.
 *  - comment add — `comment.add`; the server publishes
 *    `live.connection("Post.comments", {id}).appendNode`, which the thread's
 *    `useLiveListView` merges in place — no reload. (Declarative `insert` reaches
 *    root lists only; nested membership is server-driven by the live event.) Same
 *    for replies.
 *  - comment vote — on `CommentTreeNode` (optimistic).
 *  - comment edit — `comment.edit` writes the body back through `CommentTreeNodeView`.
 *  - comment delete — `comment.delete` is a **`Post`**-returning mutation (it
 *    re-resolves the parent for fresh counts + the reply-aware soft-delete
 *    placeholder), so fate's `delete: true` can't be used (it would
 *    `deleteRecord("Comment", id)` — wrong, the leaf-vs-soft-delete decision is
 *    the server's), and the comment lives in a nested connection. The resolver
 *    drives the thread live instead: a hard-deleted leaf publishes
 *    `deleteEdge` (the row drops via `useLiveListView`); a soft-deleted parent
 *    publishes `live.update` with the `[silindi]` tombstone (re-renders in place
 *    via the node's `useLiveView`, keeping its live replies). No reload.
 *
 * Error routing is the call-site catch (phoenix codes classify as boundary,
 * so the mutation throws; the optimistic change rolls back; we read `.code` and
 * surface it inline). See `.patterns/fate-mutations-client.md`.
 */
import type {ViewData, ViewEntity, ViewSelection} from "@nkzw/fate";
import * as React from "react";
import {useFateClient, useLiveListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link, useNavigate, useParams} from "react-router";
import type {Post} from "../../worker/fate/views";
import {useSession} from "../auth/client";
import {CommentTreeNode, CommentTreeNodeView} from "../components/pano/CommentTreeNode";
import {buildCommentTree, type CommentNode} from "../components/pano/commentTree";
import {
	PanoPostHeader,
	PanoPostHeaderView,
	PanoPostHeaderVote,
} from "../components/pano/PanoPostHeader";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {Screen} from "../fate/Screen";
import {codeOf, LoadMoreButton, toIsoOrNull} from "../fate/wire";
import type {MutationErrorCode} from "../lib/mutationErrorCodes";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "./PanoPostDetail.css";

const COMMENT_BODY_MAX = 5_000;
const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const PAGE_SIZE = 50;

/**
 * The connection selection for a post's comments — what `useLiveListView` reads.
 *
 * `live: {append: "visible"}` makes a server-pushed `appendNode` (a comment from
 * another client) appear in the thread immediately, even when the first comments
 * page window is full — without it fate's default `"edge"` mode would buffer the
 * append in a hidden `liveAfterIds` set. See `.patterns/fate-live-views.md`.
 */
const CommentConnectionView = {
	items: {node: CommentTreeNodeView},
	live: {append: "visible"},
} as const;

/**
 * The masked data a `CommentTreeNodeView` ref resolves to — the same shape
 * `useView(CommentTreeNodeView, ref)` returns. The page reads this off each
 * connection node ref synchronously (via `client.readView`) to build the tree,
 * so the type must match the hook's exactly.
 */
type CommentNodeData = ViewData<
	ViewEntity<typeof CommentTreeNodeView> & {__typename: "Comment"},
	ViewSelection<typeof CommentTreeNodeView>
>;

/**
 * The detail-page view. fate masks by view identity: the page spreads
 * `PanoPostHeaderView` (so `PanoPostHeader`/`PanoPostHeaderVote` can mask their
 * slice) and adds the nested `comments` connection whose node is
 * `CommentTreeNodeView` (so the tree nodes mask theirs). `title`/`body` ride on
 * `PanoPostHeaderView` already, which the edit form reads.
 */
const PostDetailView = view<Post>()({
	...PanoPostHeaderView,
	comments: CommentConnectionView,
});

const postErrorMessage = (code: MutationErrorCode, fallback: string): string => {
	switch (code) {
		case "TITLE_REQUIRED":
			return "başlık boş olamaz";
		case "TITLE_TOO_LONG":
			return `başlık en fazla ${TITLE_MAX} karakter olabilir`;
		case "BODY_TOO_LONG":
			return `metin en fazla ${BODY_MAX} karakter olabilir`;
		case "POST_NOT_FOUND":
			return "başlık bulunamadı";
		default:
			return fallback;
	}
};

const commentErrorMessage = (code: MutationErrorCode, fallback: string): string => {
	switch (code) {
		case "BODY_REQUIRED":
			return "yorum boş olamaz";
		case "BODY_TOO_LONG":
			return `yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`;
		case "COMMENT_NOT_FOUND":
			return "yorum bulunamadı";
		case "PARENT_NOT_FOUND":
			return "yanıtlanan yorum bulunamadı";
		default:
			return fallback;
	}
};

export function PanoPostDetail() {
	const {id} = useParams<{id: string}>();
	const safeId = id ?? "";
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Link to="/pano" className="kp-pano-postpage__back">
					← akışa dön
				</Link>
				<Screen
					fallback={<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>}
					error={({code}) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							başlık yüklenemedi: {code.toLowerCase()}
						</p>
					)}
				>
					<PostContent idOrSlug={safeId} />
				</Screen>
			</div>
		</div>
	);
}

function PostContent({idOrSlug}: {idOrSlug: string}) {
	const {post} = useRequest({
		post: {view: PostDetailView, args: {idOrSlug, comments: {first: PAGE_SIZE}}},
	});

	if (!post) {
		return (
			<NotFoundPage
				title="başlık bulunamadı"
				message={`"${idOrSlug}" diye bir başlık bulamadık. başka bir şeye bakmak ister misin?`}
			/>
		);
	}

	return <PostContentInner post={post} />;
}

function PostContentInner({post}: {post: ViewRef<"Post">}) {
	const data = useView(PanoPostHeaderView, post);
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();

	const [editing, setEditing] = React.useState(false);
	const [editTitle, setEditTitle] = React.useState("");
	const [editBody, setEditBody] = React.useState("");
	const [editError, setEditError] = React.useState<string | null>(null);
	const [editInFlight, setEditInFlight] = React.useState(false);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);
	const [deleteInFlight, setDeleteInFlight] = React.useState(false);

	const isAuthor = !!session.data?.user && session.data.user.id === data.authorId;

	function onEditClick() {
		setEditTitle(data.title);
		setEditBody(data.body ?? "");
		setEditError(null);
		setEditing(true);
	}

	async function onEditSubmit(e: React.FormEvent) {
		e.preventDefault();
		const trimmedTitle = editTitle.trim();
		if (trimmedTitle.length === 0) {
			setEditError("başlık boş olamaz");
			return;
		}
		if (trimmedTitle.length > TITLE_MAX) {
			setEditError(`başlık en fazla ${TITLE_MAX} karakter olabilir`);
			return;
		}
		if (editBody.length > BODY_MAX) {
			setEditError(`metin en fazla ${BODY_MAX} karakter olabilir`);
			return;
		}
		setEditError(null);
		setEditInFlight(true);
		try {
			// `post.edit` returns the updated `Post`; writing it back through
			// `PanoPostHeaderView` re-renders the header in place (no reload).
			const {error} = await fate.mutations.post.edit({
				input: {id: data.id, title: trimmedTitle, body: editBody},
				view: PanoPostHeaderView,
			});
			if (error) {
				setEditError(postErrorMessage(codeOf(error), error.message));
				return;
			}
			setEditing(false);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`/pano/${data.slug ?? data.id}`));
				return;
			}
			setEditError(postErrorMessage(code, "başlık güncellenemedi"));
		} finally {
			setEditInFlight(false);
		}
	}

	async function onDeleteConfirm() {
		setDeleteError(null);
		setDeleteInFlight(true);
		try {
			// A post has no parent; `delete: true` evicts it by id across all
			// connections (incl. the feed root list) — declarative, no imperative
			// updater. We navigate back to /pano on success.
			const {error} = await fate.mutations.post.delete({input: {id: data.id}, delete: true});
			if (error) {
				setDeleteError(postErrorMessage(codeOf(error), error.message));
				return;
			}
			setConfirmDelete(false);
			navigate("/pano");
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`/pano/${data.slug ?? data.id}`));
				return;
			}
			setDeleteError(postErrorMessage(code, "başlık silinemedi"));
		} finally {
			setDeleteInFlight(false);
		}
	}

	return (
		<>
			<header className="kp-pano-postpage__head">
				<PanoPostHeaderVote post={post} />
				{editing ? (
					<form className="kp-pano-edit-post" onSubmit={onEditSubmit}>
						<input
							className="kp-pano-edit-post__title"
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							disabled={editInFlight}
							data-testid="post-edit-title"
							maxLength={TITLE_MAX + 50}
						/>
						<textarea
							className="kp-pano-edit-post__body"
							value={editBody}
							onChange={(e) => setEditBody(e.target.value)}
							disabled={editInFlight}
							data-testid="post-edit-body"
							maxLength={BODY_MAX + 100}
						/>
						{editError ? (
							<p
								className="kp-pano-edit-post__error"
								role="alert"
								data-testid="post-edit-error"
								style={{color: "var(--danger)", font: "var(--t-meta)"}}
							>
								{editError}
							</p>
						) : null}
						<div style={{display: "flex", gap: 6}}>
							<Button
								variant="tertiary"
								size="sm"
								type="button"
								disabled={editInFlight}
								onClick={() => {
									setEditing(false);
									setEditError(null);
								}}
							>
								iptal
							</Button>
							<Button
								variant="primary"
								size="sm"
								type="submit"
								disabled={editInFlight || editTitle.trim().length === 0}
								data-testid="post-edit-save"
							>
								{editInFlight ? "kaydediliyor…" : "kaydet"}
							</Button>
						</div>
					</form>
				) : (
					<PanoPostHeader
						post={post}
						isAuthor={isAuthor}
						onEdit={onEditClick}
						onDelete={() => setConfirmDelete(true)}
					/>
				)}
			</header>

			{isAuthor ? (
				<Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
					<Dialog.Popup>
						<Dialog.Head
							title="başlığı sil"
							description="bu başlığı silmek istediğine emin misin? geri alınamaz."
						/>
						<Dialog.Body>
							{deleteError ? (
								<p role="alert" style={{color: "var(--danger)", font: "var(--t-meta)"}}>
									{deleteError}
								</p>
							) : null}
						</Dialog.Body>
						<Dialog.Foot>
							<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
							<Button
								variant="primary"
								type="button"
								disabled={deleteInFlight}
								data-testid="post-delete-confirm"
								onClick={onDeleteConfirm}
							>
								{deleteInFlight ? "siliniyor…" : "sil"}
							</Button>
						</Dialog.Foot>
					</Dialog.Popup>
				</Dialog.Root>
			) : null}

			<Comments
				post={post}
				postId={data.id}
				signedIn={!!session.data?.user}
				currentUserId={session.data?.user?.id ?? null}
			/>
		</>
	);
}

interface CommentsProps {
	post: ViewRef<"Post">;
	postId: string;
	signedIn: boolean;
	currentUserId: string | null;
}

function Comments(props: CommentsProps) {
	const post = useView(PostDetailView, props.post);
	const fate = useFateClient();
	// Live: a `comment.add` on another client publishes
	// `live.connection("Post.comments", {id}).appendNode`, which `useLiveListView`
	// merges into this thread without a refetch. Comment *delete* is also live: a
	// hard-deleted leaf publishes `deleteEdge` (consumed here, the row drops), a
	// soft-deleted parent publishes `live.update` with the `[silindi]` tombstone
	// (consumed by the node's own `useLiveView`, re-rendering in place so its live
	// replies keep their parent — the row stays in the connection). See the delete
	// handler below.
	const [items, loadNext] = useLiveListView(CommentConnectionView, post.comments);

	const [replyTo, setReplyTo] = React.useState<string | null>(null);
	const [editingCommentId, setEditingCommentId] = React.useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);
	const [deleteInFlight, setDeleteInFlight] = React.useState(false);
	const navigate = useNavigate();

	// fate masks comment fields behind the node view, so the bare connection refs
	// don't carry `parentId`/`deletedAt`/`body`. But the connection just resolved
	// every node against `CommentTreeNodeView`, so each node's masked data is
	// already in the store — read it synchronously here (no per-node hook, no
	// effect round-trip) and build the tree in the same render the nodes arrive in.
	// A node still missing from the cache (no fulfilled snapshot) is skipped this
	// frame and picked up when the connection delivers it — it never lands in
	// `items` without its data in practice, since membership and node data arrive
	// together. The whole tree re-derives whenever `items` changes (membership is
	// the only thing that changes the tree shape: `parentId` is immutable and a
	// soft-delete reloads the page).
	const {roots, childrenByParent, bodyById, refById, visibleCount} = React.useMemo(() => {
		const nodes: Array<CommentNode<ViewRef<"Comment">>> = [];
		for (const {node} of items) {
			const snapshot = fate.readView(CommentTreeNodeView, node);
			if (snapshot.status !== "fulfilled") continue;
			const data = snapshot.value.data as CommentNodeData;
			nodes.push({
				id: String(data.id),
				parentId: data.parentId != null ? String(data.parentId) : null,
				deletedAt: toIsoOrNull(data.deletedAt),
				body: data.body,
				ref: node,
			});
		}
		return buildCommentTree(nodes);
	}, [items, fate]);

	const childrenForId = React.useCallback(
		(id: string): ReadonlyArray<{id: string; ref: ViewRef<"Comment">}> =>
			childrenByParent.get(id) ?? [],
		[childrenByParent],
	);

	async function onDeleteConfirm() {
		if (!confirmDeleteId) return;
		setDeleteError(null);
		setDeleteInFlight(true);
		try {
			// `comment.delete` returns the re-resolved **parent `Post`** (reply-aware
			// soft-delete vs hard-delete is the server's decision). It lives in the
			// nested `Post.comments` connection, so we can't use `delete: true` (wrong
			// entity). The resolver drives the thread live: a hard-deleted leaf
			// publishes `deleteEdge` (consumed by `useLiveListView` — the row drops),
			// a soft-deleted parent publishes `live.update` with the `[silindi]`
			// tombstone (consumed by the node's own `useLiveView` — it re-renders in
			// place, keeping its live replies). No reload either way.
			const {error} = await fate.mutations.comment.delete({input: {id: confirmDeleteId}});
			if (error) {
				setDeleteError(commentErrorMessage(codeOf(error), error.message));
				return;
			}
			setConfirmDeleteId(null);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`/pano/${props.postId}`));
				return;
			}
			setDeleteError(commentErrorMessage(code, "yorum silinemedi"));
		} finally {
			setDeleteInFlight(false);
		}
	}

	const composerFor = React.useCallback(
		(id: string) => ({
			replyComposer:
				replyTo === id ? (
					<CommentComposer
						postId={props.postId}
						parentId={id}
						signedIn={props.signedIn}
						onPosted={() => setReplyTo(null)}
						onCancel={() => setReplyTo(null)}
						autoFocus
					/>
				) : undefined,
			editComposer:
				editingCommentId === id ? (
					<CommentEditComposer
						commentId={id}
						commentRef={refById.get(id) ?? null}
						initialBody={bodyById.get(id) ?? ""}
						onEdited={() => setEditingCommentId(null)}
						onCancel={() => setEditingCommentId(null)}
					/>
				) : undefined,
		}),
		[replyTo, editingCommentId, props.postId, props.signedIn, bodyById, refById],
	);

	return (
		<>
			<CommentComposer
				postId={props.postId}
				parentId={null}
				signedIn={props.signedIn}
				onPosted={() => undefined}
			/>
			<h2 className="kp-pano-postpage__thread-heading">{visibleCount} yorum</h2>
			<div className="kp-pano-thread">
				{roots.map((r) => (
					<CommentTreeNode
						key={r.id}
						comment={r.ref}
						children={childrenForId(r.id)}
						childrenForId={childrenForId}
						currentUserId={props.currentUserId}
						onReply={(id) => setReplyTo(id)}
						onEdit={(id) => setEditingCommentId(id)}
						onDelete={(id) => {
							setDeleteError(null);
							setConfirmDeleteId(id);
						}}
						composerFor={composerFor}
					/>
				))}
			</div>
			{loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
			<Dialog.Root
				open={confirmDeleteId != null}
				onOpenChange={(open) => {
					if (!open) {
						setConfirmDeleteId(null);
						setDeleteError(null);
					}
				}}
			>
				<Dialog.Popup>
					<Dialog.Head
						title="yorumu sil"
						description="bu yorumu silmek istediğine emin misin? geri alınamaz."
					/>
					<Dialog.Body>
						{deleteError ? (
							<p role="alert" style={{color: "var(--danger)", font: "var(--t-meta)"}}>
								{deleteError}
							</p>
						) : null}
					</Dialog.Body>
					<Dialog.Foot>
						<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
						<Button
							variant="primary"
							type="button"
							disabled={deleteInFlight}
							data-testid="pano-comment-delete-confirm"
							onClick={onDeleteConfirm}
						>
							{deleteInFlight ? "siliniyor…" : "sil"}
						</Button>
					</Dialog.Foot>
				</Dialog.Popup>
			</Dialog.Root>
		</>
	);
}

/**
 * Top-level + nested comment composer — fate. Submits `comment.add`; the server
 * publishes `live.connection("Post.comments", {id}).appendNode` with the inline
 * node, so the thread's `useLiveListView` merges the new comment in place — no
 * reload. (Declarative `insert` reaches root lists only; nested-connection
 * membership is server-driven by the live event, which is why one publish updates
 * both the author's own view and every other client viewing the post.)
 */
function CommentComposer({
	postId,
	parentId,
	signedIn,
	onPosted,
	onCancel,
	autoFocus,
}: {
	postId: string;
	parentId: string | null;
	signedIn: boolean;
	onPosted: () => void;
	onCancel?: () => void;
	autoFocus?: boolean;
}) {
	const fate = useFateClient();
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const navigate = useNavigate();
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

	React.useEffect(() => {
		if (autoFocus) textareaRef.current?.focus();
	}, [autoFocus]);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!signedIn) {
			navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));
			return;
		}
		const trimmed = body.trim();
		if (trimmed.length === 0) {
			setError("yorum boş olamaz");
			return;
		}
		if (body.length > COMMENT_BODY_MAX) {
			setError(`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`);
			return;
		}
		setError(null);
		setInFlight(true);
		try {
			const {error: callError} = await fate.mutations.comment.add({
				input: {postId, body, ...(parentId ? {parentId} : {})},
				view: CommentTreeNodeView,
			});
			if (callError) {
				setError(commentErrorMessage(codeOf(callError), callError.message));
				return;
			}
			setBody("");
			onPosted();
			onCancel?.();
			// Live: the server published `live.connection("Post.comments", {id})
			// .appendNode` for the new comment, so `useLiveListView` merges it into
			// the thread in place — no reload needed (this client's own
			// subscription delivers it the same way a second client sees it).
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));
				return;
			}
			setError(commentErrorMessage(code, "yorum eklenemedi"));
		} finally {
			setInFlight(false);
		}
	}

	// Test affordances key off the raw parent comment id (`comm_<ulid>`).
	const testId = parentId ? `pano-comment-reply-${parentId}` : "pano-comment-composer";

	return (
		<form className="kp-pano-comment-composer" onSubmit={submit} data-testid={testId}>
			<textarea
				ref={textareaRef}
				className="kp-pano-comment-composer__textarea"
				placeholder={
					signedIn
						? "yorum yaz. markdown çalışır, ``` ``` kod bloğu çalışır."
						: "yorum yazmak için giriş yap"
				}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				disabled={inFlight || !signedIn}
				data-testid={parentId ? `pano-comment-reply-input-${parentId}` : "pano-comment-input"}
				maxLength={COMMENT_BODY_MAX + 100}
			/>
			{error ? (
				<p
					role="alert"
					data-testid="pano-comment-error"
					style={{color: "var(--danger)", font: "var(--t-meta)"}}
				>
					{error}
				</p>
			) : null}
			<div className="kp-pano-comment-composer__foot">
				<span className="kp-pano-comment-composer__hint">
					markdown · <kbd>⌘</kbd>+<kbd>↵</kbd>
				</span>
				<div style={{display: "flex", gap: 6}}>
					{onCancel ? (
						<Button
							variant="tertiary"
							size="sm"
							type="button"
							onClick={onCancel}
							disabled={inFlight}
						>
							iptal
						</Button>
					) : null}
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={inFlight || body.trim().length === 0}
						data-testid={parentId ? `pano-comment-reply-submit-${parentId}` : "pano-comment-submit"}
					>
						{inFlight ? "gönderiliyor…" : parentId ? "yanıtla" : "yorum ekle"}
					</Button>
				</div>
			</div>
		</form>
	);
}

/**
 * Inline comment edit composer — fate. `comment.edit` writes the new body back
 * through `CommentTreeNodeView` (the same view the node reads), so the edited
 * comment re-renders in place with no reload.
 */
function CommentEditComposer({
	commentId,
	initialBody,
	onEdited,
	onCancel,
}: {
	commentId: string;
	/** Carried for symmetry / future optimistic edit; the write-back is keyed by id. */
	commentRef: ViewRef<"Comment"> | null;
	initialBody: string;
	onEdited: () => void;
	onCancel: () => void;
}) {
	const fate = useFateClient();
	const [body, setBody] = React.useState(initialBody);
	const [error, setError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const navigate = useNavigate();
	// Test affordances key off the raw comment id (`comm_<ulid>`).
	const localId = commentId;

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = body.trim();
		if (trimmed.length === 0) {
			setError("yorum boş olamaz");
			return;
		}
		if (body.length > COMMENT_BODY_MAX) {
			setError(`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`);
			return;
		}
		setError(null);
		setInFlight(true);
		try {
			const {error: callError} = await fate.mutations.comment.edit({
				input: {id: commentId, body},
				view: CommentTreeNodeView,
			});
			if (callError) {
				setError(commentErrorMessage(codeOf(callError), callError.message));
				return;
			}
			onEdited();
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`${window.location.pathname}${window.location.search}`));
				return;
			}
			setError(commentErrorMessage(code, "yorum güncellenemedi"));
		} finally {
			setInFlight(false);
		}
	}

	return (
		<form
			className="kp-pano-comment-composer"
			onSubmit={submit}
			data-testid={`pano-comment-edit-form-${localId}`}
		>
			<textarea
				className="kp-pano-comment-composer__textarea"
				value={body}
				onChange={(e) => setBody(e.target.value)}
				disabled={inFlight}
				data-testid={`pano-comment-edit-input-${localId}`}
				maxLength={COMMENT_BODY_MAX + 100}
			/>
			{error ? (
				<p
					role="alert"
					data-testid={`pano-comment-edit-error-${localId}`}
					style={{color: "var(--danger)", font: "var(--t-meta)"}}
				>
					{error}
				</p>
			) : null}
			<div className="kp-pano-comment-composer__foot">
				<span className="kp-pano-comment-composer__hint">
					markdown · <kbd>⌘</kbd>+<kbd>↵</kbd>
				</span>
				<div style={{display: "flex", gap: 6}}>
					<Button variant="tertiary" size="sm" type="button" onClick={onCancel} disabled={inFlight}>
						iptal
					</Button>
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={inFlight || body.trim().length === 0}
						data-testid={`pano-comment-edit-save-${localId}`}
					>
						{inFlight ? "kaydediliyor…" : "kaydet"}
					</Button>
				</div>
			</div>
		</form>
	);
}
