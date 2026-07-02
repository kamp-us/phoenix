/**
 * Post-detail page — fate. One batched `useRequest` resolves the header + first
 * page of comments; `PostDetailView` spreads `PanoPostHeaderView` and adds the
 * nested `comments` connection (node: `CommentTreeNodeView`), so children mask
 * their slice off the same refs. See `.patterns/fate-connections.md`.
 *
 * One non-obvious mutation: `comment.delete` returns the parent **`Post`** (the
 * leaf-hard-delete vs parent-soft-delete-tombstone decision is the server's), so
 * fate's `delete: true` can't be used and the resolver drives the thread live.
 * Error routing is the call-site catch — see `.patterns/fate-mutations-client.md`.
 */
import type {ViewData, ViewEntity, ViewSelection} from "@nkzw/fate";
import * as React from "react";
import {useFateClient, useLiveListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link, useLocation, useNavigate, useParams} from "react-router";
import type {Post, ReportReceipt} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {CommentTreeNode, CommentTreeNodeView} from "../components/pano/CommentTreeNode";
import {buildCommentTree, type CommentNode} from "../components/pano/commentTree";
import {
	PanoPostHeader,
	PanoPostHeaderView,
	PanoPostHeaderVote,
} from "../components/pano/PanoPostHeader";
import {PanoPostSkeleton} from "../components/pano/PanoSkeleton";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import type {ReportOutcome} from "../components/ui/ReportButton";
import {bodyEditOptimistic, postEditOptimistic} from "../fate/optimisticEdit";
import {Screen} from "../fate/Screen";
import {useDraft, useDraftSubmit} from "../fate/useDraftSubmit";
import {useReadbackRefetch} from "../fate/useReadbackRefetch";
import {codeOf, LoadMoreButton, toIsoOrNull} from "../fate/wire";
import {messageForCode, type WireMessageOverrides} from "../fate/wireMessages";
import {PHOENIX_OPTIMISTIC_EDITS} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {submitOnCmdEnter} from "../lib/submitShortcut";
import {NotFoundPage} from "./NotFoundPage";
import "./PanoPostDetail.css";

const COMMENT_BODY_MAX = 5_000;
const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const PAGE_SIZE = 50;

/**
 * `live: {append: "visible"}` makes a server-pushed `appendNode` (a comment from
 * another client) appear immediately, instead of fate's default `"edge"` mode
 * buffering it until a page load. See `.patterns/fate-live-views.md`.
 */
const CommentConnectionView = {
	items: {node: CommentTreeNodeView},
	live: {append: "visible"},
} as const;

/**
 * The masked data a `CommentTreeNodeView` ref resolves to. The page reads this
 * off each node ref synchronously (`client.readView`) to build the tree, so the
 * type must match `useView(CommentTreeNodeView, ref)` exactly.
 */
type CommentNodeData = ViewData<
	ViewEntity<typeof CommentTreeNodeView> & {__typename: "Comment"},
	ViewSelection<typeof CommentTreeNodeView>
>;

/**
 * The detail-page view. fate masks by view identity, so the page **spreads**
 * `PanoPostHeaderView` and `CommentTreeNodeView` (via the connection) for the
 * children to mask their slice off the same refs.
 */
const PostDetailView = view<Post>()({
	...PanoPostHeaderView,
	comments: CommentConnectionView,
});

/**
 * Client view for the `report.submit` ack (ADR 0082 — a report has no read view, so
 * the mutation returns this small receipt). `created` is `false` on the idempotent
 * re-report no-op, which the button surfaces as "zaten bildirildi".
 */
const ReportReceiptView = view<ReportReceipt>()({
	id: true,
	created: true,
});

/**
 * The page's `bildir` handler factory: submits a report for one target, mapping the
 * outcome to the `ReportButton`'s feedback states and routing a signed-out click to
 * auth. The shared content components stay report-logic-free — they only render the
 * button and forward this handler.
 */
function useReportHandler() {
	const fate = useFateClient();
	const navigate = useNavigate();
	const session = useSession();

	return React.useCallback(
		async (targetKind: "post" | "comment", targetId: string): Promise<ReportOutcome> => {
			if (!session.data?.user) {
				navigate(authRedirectPath(currentLocationPath()));
				return "redirected";
			}
			try {
				const {result, error} = await fate.mutations.report.submit({
					input: {targetKind, targetId},
					view: ReportReceiptView,
				});
				if (error) {
					if (codeOf(error) === "UNAUTHORIZED") {
						navigate(authRedirectPath(currentLocationPath()));
						return "redirected";
					}
					return "error";
				}
				return result?.created === false ? "already" : "reported";
			} catch (caught) {
				if (codeOf(caught) === "UNAUTHORIZED") {
					navigate(authRedirectPath(currentLocationPath()));
					return "redirected";
				}
				return "error";
			}
		},
		[fate, navigate, session.data?.user],
	);
}

/** Post-form copy that overrides the shared {@link WIRE_MESSAGES} base. */
const POST_OVERRIDES: WireMessageOverrides = {
	TITLE_REQUIRED: "başlık boş olamaz",
	TITLE_TOO_LONG: `başlık en fazla ${TITLE_MAX} karakter olabilir`,
	BODY_TOO_LONG: `metin en fazla ${BODY_MAX} karakter olabilir`,
	POST_NOT_FOUND: "başlık bulunamadı",
};

/** Comment-form copy that overrides the shared {@link WIRE_MESSAGES} base. */
const COMMENT_OVERRIDES: WireMessageOverrides = {
	BODY_REQUIRED: "yorum boş olamaz",
	BODY_TOO_LONG: `yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
	COMMENT_NOT_FOUND: "yorum bulunamadı",
	PARENT_NOT_FOUND: "yanıtlanan yorum bulunamadı",
};

const currentLocationPath = () => `${window.location.pathname}${window.location.search}`;

/** Client-side comment-body validation. Messages come from the shared registry. */
const validateCommentBody = (trimmed: string, body: string): string | null => {
	if (trimmed.length === 0) return messageForCode("BODY_REQUIRED", COMMENT_OVERRIDES);
	if (body.length > COMMENT_BODY_MAX) return messageForCode("BODY_TOO_LONG", COMMENT_OVERRIDES);
	return null;
};

/** Client-side post-edit validation. Messages come from the shared registry. */
const validatePostFields = (trimmedTitle: string, body: string): string | null => {
	if (trimmedTitle.length === 0) return messageForCode("TITLE_REQUIRED", POST_OVERRIDES);
	if (trimmedTitle.length > TITLE_MAX) return messageForCode("TITLE_TOO_LONG", POST_OVERRIDES);
	if (body.length > BODY_MAX) return messageForCode("BODY_TOO_LONG", POST_OVERRIDES);
	return null;
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
					fallback={<PanoPostSkeleton />}
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

	return <PostContentInner post={post} idOrSlug={idOrSlug} />;
}

function PostContentInner({post, idOrSlug}: {post: ViewRef<"Post">; idOrSlug: string}) {
	const data = useView(PanoPostHeaderView, post);
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();
	const report = useReportHandler();
	// Dark-ship gate (#1675): with the flag off the edit passes no optimistic
	// payload and waits for the round-trip, exactly as before.
	const {value: optimisticEdits} = useFlag(PHOENIX_OPTIMISTIC_EDITS, false);

	const [editing, setEditing] = React.useState(false);
	const [editTitle, setEditTitle] = React.useState("");
	const [editBody, setEditBody] = React.useState("");
	const [confirmDelete, setConfirmDelete] = React.useState(false);

	const postRedirectPath = () => `/pano/${data.slug ?? data.id}`;
	const {
		error: editError,
		setError: setEditError,
		inFlight: editInFlight,
		run: runEdit,
	} = useDraftSubmit({overrides: POST_OVERRIDES, redirectPath: postRedirectPath});
	const {
		error: deleteError,
		inFlight: deleteInFlight,
		run: runDelete,
	} = useDraftSubmit({overrides: POST_OVERRIDES, redirectPath: postRedirectPath});

	const isAuthor = !!session.data?.user && session.data.user.id === data.authorId;

	function onEditClick() {
		setEditTitle(data.title);
		setEditBody(data.body ?? "");
		setEditError(null);
		setEditing(true);
	}

	async function onEditSubmit(e: React.SyntheticEvent) {
		e.preventDefault();
		const trimmedTitle = editTitle.trim();
		const validationError = validatePostFields(trimmedTitle, editBody);
		if (validationError != null) {
			setEditError(validationError);
			return;
		}
		const optimistic = postEditOptimistic(optimisticEdits, {title: trimmedTitle, body: editBody});
		await runEdit(
			() =>
				fate.mutations.post.edit({
					input: {id: data.id, title: trimmedTitle, body: editBody},
					...(optimistic ? {optimistic} : {}),
					view: PanoPostHeaderView,
				}),
			"başlık güncellenemedi",
			() => setEditing(false),
		);
	}

	async function onDeleteConfirm() {
		// `delete: true` evicts the post by id across all connections (incl. the
		// feed root list) — declarative, no imperative updater.
		await runDelete(
			() => fate.mutations.post.delete({input: {id: data.id}, delete: true}),
			"başlık silinemedi",
			() => {
				setConfirmDelete(false);
				navigate("/pano");
			},
		);
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
						onReport={() => report("post", data.id)}
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
				idOrSlug={idOrSlug}
				postPath={`/pano/${data.slug ?? data.id}`}
				signedIn={!!session.data?.user}
				currentUserId={session.data?.user?.id ?? null}
			/>
		</>
	);
}

interface CommentsProps {
	post: ViewRef<"Post">;
	postId: string;
	/** The `idOrSlug` the page request resolved under — the read-back refetch re-runs it verbatim. */
	idOrSlug: string;
	/** Parent post's canonical path; threaded into each node for its comment-anchor share URL. */
	postPath: string;
	signedIn: boolean;
	currentUserId: string | null;
}

/**
 * Resolves the `#comment-<id>` permalink anchor: returns the targeted comment id and
 * scrolls its node into view once it's rendered. Comments arrive async (fate
 * connection), so the native browser hash-jump misses — and the node mounts only when
 * its `CommentTreeNodeView` snapshot *fulfills*, a store update independent of list
 * membership (#649). Keying a retry on `items.length` therefore races: membership can
 * settle before the target node fulfills, and the effect never re-fires. A
 * MutationObserver watches the thread subtree until `#comment-<id>` exists, scrolls it
 * once, then disconnects — so the cold-load path no longer depends on a reactive key
 * happening to change at the right moment.
 *
 * A permalinked comment on a not-yet-loaded pagination page is never observed (it's
 * not in the DOM) — an accepted product limit.
 */
function useCommentAnchor(): string | null {
	const {hash} = useLocation();
	const activeId = hash.startsWith("#comment-") ? hash.slice("#comment-".length) : null;
	const scrolledFor = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (!activeId || scrolledFor.current === activeId) return;

		const scroll = (el: Element): boolean => {
			scrolledFor.current = activeId;
			el.scrollIntoView({behavior: "smooth", block: "center"});
			return true;
		};

		const existing = document.getElementById(`comment-${activeId}`);
		if (existing) {
			scroll(existing);
			return;
		}

		const observer = new MutationObserver(() => {
			const el = document.getElementById(`comment-${activeId}`);
			if (el) {
				scroll(el);
				observer.disconnect();
			}
		});
		observer.observe(document.body, {childList: true, subtree: true});
		return () => observer.disconnect();
	}, [activeId]);

	return activeId;
}

function Comments(props: CommentsProps) {
	const post = useView(PostDetailView, props.post);
	const fate = useFateClient();
	const report = useReportHandler();
	const [items, loadNext] = useLiveListView(CommentConnectionView, post.comments);
	const activeCommentId = useCommentAnchor();

	// Deterministic read-back: if the server's `appendNode` push for the author's own
	// new comment is lost (publish-vs-register race, #714), refetch this page's request
	// `network-only` so the comment lands without a manual refresh.
	const confirmComment = useReadbackRefetch({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: () =>
			fate.request(
				{
					post: {
						view: PostDetailView,
						args: {idOrSlug: props.idOrSlug, comments: {first: PAGE_SIZE}},
					},
				},
				{mode: "network-only"},
			),
	});

	const [replyTo, setReplyTo] = React.useState<string | null>(null);
	const [editingCommentId, setEditingCommentId] = React.useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
	const {
		error: deleteError,
		setError: setDeleteError,
		inFlight: deleteInFlight,
		run: runDelete,
	} = useDraftSubmit({
		overrides: COMMENT_OVERRIDES,
		redirectPath: () => `/pano/${props.postId}`,
	});

	// The connection resolved every node against `CommentTreeNodeView`, so each
	// node's masked data is already in the store — read it synchronously (no
	// per-node hook) and build the tree in the same render the nodes arrive in. A
	// not-yet-fulfilled node is skipped this frame; membership and node data arrive
	// together in practice. Re-derives only on `items` change: `parentId` is
	// immutable and a soft-delete reloads the page.
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
		// `comment.delete` returns the re-resolved parent `Post` (leaf-hard-delete
		// vs parent-soft-delete-tombstone is the server's call), so we can't use
		// `delete: true`. The resolver drives the row live: hard delete → `deleteEdge`
		// (row drops), soft delete → `live.update` with the `[silindi]` tombstone.
		await runDelete(
			() => fate.mutations.comment.delete({input: {id: confirmDeleteId}}),
			"yorum silinemedi",
			() => setConfirmDeleteId(null),
		);
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
						onConfirm={confirmComment}
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
		[replyTo, editingCommentId, props.postId, props.signedIn, bodyById, refById, confirmComment],
	);

	return (
		<>
			<CommentComposer
				postId={props.postId}
				parentId={null}
				signedIn={props.signedIn}
				onPosted={() => undefined}
				onConfirm={confirmComment}
			/>
			<h2 className="kp-pano-postpage__thread-heading">{visibleCount} yorum</h2>
			<div className="kp-pano-thread">
				{roots.map((r) => (
					<CommentTreeNode
						key={r.id}
						comment={r.ref}
						postPath={props.postPath}
						activeCommentId={activeCommentId}
						children={childrenForId(r.id)}
						childrenForId={childrenForId}
						currentUserId={props.currentUserId}
						onReply={(id) => setReplyTo(id)}
						onEdit={(id) => setEditingCommentId(id)}
						onDelete={(id) => {
							setDeleteError(null);
							setConfirmDeleteId(id);
						}}
						onReport={(id) => report("comment", id)}
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
 * Top-level + nested comment composer — fate. Submits `comment.add`; the server's
 * `appendNode` live event merges the new comment into the thread in place (the
 * author's own view included), since nested-connection membership is server-driven.
 */
function CommentComposer({
	postId,
	parentId,
	signedIn,
	onPosted,
	onCancel,
	onConfirm,
	autoFocus,
}: {
	postId: string;
	parentId: string | null;
	signedIn: boolean;
	onPosted: () => void;
	onCancel?: () => void;
	/** Hands the created comment's id to the deterministic read-back (see {@link useReadbackRefetch}). */
	onConfirm?: (commentId: string) => void;
	autoFocus?: boolean;
}) {
	const fate = useFateClient();
	const navigate = useNavigate();
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
	const createdId = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (autoFocus) textareaRef.current?.focus();
	}, [autoFocus]);

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody: "",
		validate: validateCommentBody,
		redirectPath: currentLocationPath,
		run: async (value) => {
			const {result, error: callError} = await fate.mutations.comment.add({
				input: {postId, body: value, ...(parentId ? {parentId} : {})},
				view: CommentTreeNodeView,
			});
			createdId.current = result?.id != null ? String(result.id) : null;
			return {error: callError};
		},
		overrides: COMMENT_OVERRIDES,
		failureFallback: "yorum eklenemedi",
		onSuccess: () => {
			setBody("");
			if (createdId.current) onConfirm?.(createdId.current);
			onPosted();
			onCancel?.();
		},
	});

	function onSubmit(e: React.SyntheticEvent) {
		if (!signedIn) {
			e.preventDefault();
			navigate(authRedirectPath(currentLocationPath()));
			return;
		}
		void submit(e);
	}

	const testId = parentId ? `pano-comment-reply-${parentId}` : "pano-comment-composer";

	return (
		<form className="kp-pano-comment-composer" onSubmit={onSubmit} data-testid={testId}>
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
				onKeyDown={submitOnCmdEnter}
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
 * through `CommentTreeNodeView` (the view the node reads), so it re-renders in
 * place; behind the `phoenix-optimistic-edits` flag it also passes an optimistic
 * `{body, updatedAt}` so the edit renders before the round-trip (#1675).
 */
function CommentEditComposer({
	commentId,
	initialBody,
	onEdited,
	onCancel,
}: {
	commentId: string;
	/** Carried for symmetry; the write-back + optimistic update are keyed by id. */
	commentRef: ViewRef<"Comment"> | null;
	initialBody: string;
	onEdited: () => void;
	onCancel: () => void;
}) {
	const fate = useFateClient();
	const localId = commentId;
	// Dark-ship gate (#1675): flag off ⇒ no optimistic payload (round-trip wait).
	const {value: optimisticEdits} = useFlag(PHOENIX_OPTIMISTIC_EDITS, false);

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody,
		validate: validateCommentBody,
		redirectPath: currentLocationPath,
		run: (value) => {
			const optimistic = bodyEditOptimistic(optimisticEdits, value);
			return fate.mutations.comment.edit({
				input: {id: commentId, body: value},
				...(optimistic ? {optimistic} : {}),
				view: CommentTreeNodeView,
			});
		},
		overrides: COMMENT_OVERRIDES,
		failureFallback: "yorum güncellenemedi",
		onSuccess: onEdited,
	});

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
				onKeyDown={submitOnCmdEnter}
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
