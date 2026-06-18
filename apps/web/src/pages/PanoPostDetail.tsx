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
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import type {ReportOutcome} from "../components/ui/ReportButton";
import {Screen} from "../fate/Screen";
import {codeOf, LoadMoreButton, toIsoOrNull} from "../fate/wire";
import type {MutationErrorCode} from "../lib/mutationErrorCodes";
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

const currentLocationPath = () => `${window.location.pathname}${window.location.search}`;

/**
 * The "in-flight + error + UNAUTHORIZED-redirect" submit envelope shared by every
 * form on this page. `run` flips `inFlight`, maps a returned wire error, and on
 * an `UNAUTHORIZED` throw navigates to the auth redirect. Single-field composers
 * layer `useDraft` on top; the two-field post-edit form uses this directly.
 */
function useDraftSubmit(options: {
	errorMessage: (code: MutationErrorCode, fallback: string) => string;
	redirectPath: () => string;
}) {
	const [error, setError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const navigate = useNavigate();

	const run = async (
		mutate: () => Promise<{error?: {message: string} | null}>,
		failureFallback: string,
		onSuccess: () => void,
	) => {
		setError(null);
		setInFlight(true);
		try {
			const {error: callError} = await mutate();
			if (callError) {
				setError(options.errorMessage(codeOf(callError), callError.message));
				return;
			}
			onSuccess();
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(options.redirectPath()));
				return;
			}
			setError(options.errorMessage(code, failureFallback));
		} finally {
			setInFlight(false);
		}
	};

	return {error, setError, inFlight, run};
}

/**
 * Shared single-body draft (validated textarea + the `useDraftSubmit` envelope),
 * used by the comment-add and comment-edit composers. `validate` returns one of
 * the page's `*ErrorMessage` strings — messages are not restated here.
 */
function useDraft(options: {
	initialBody: string;
	validate: (trimmed: string, body: string) => string | null;
	redirectPath: () => string;
	run: (body: string) => Promise<{error?: {message: string} | null}>;
	errorMessage: (code: MutationErrorCode, fallback: string) => string;
	failureFallback: string;
	onSuccess: () => void;
}) {
	const [body, setBody] = React.useState(options.initialBody);
	const {error, setError, inFlight, run} = useDraftSubmit({
		errorMessage: options.errorMessage,
		redirectPath: options.redirectPath,
	});

	const submit = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		const trimmed = body.trim();
		const validationError = options.validate(trimmed, body);
		if (validationError != null) {
			setError(validationError);
			return;
		}
		await run(() => options.run(body), options.failureFallback, options.onSuccess);
	};

	return {body, setBody, error, setError, inFlight, submit};
}

/** Client-side comment-body validation. Messages come from `commentErrorMessage` (single source). */
const validateCommentBody = (trimmed: string, body: string): string | null => {
	if (trimmed.length === 0) return commentErrorMessage("BODY_REQUIRED", "");
	if (body.length > COMMENT_BODY_MAX) return commentErrorMessage("BODY_TOO_LONG", "");
	return null;
};

/** Client-side post-edit validation. Messages come from `postErrorMessage` (single source). */
const validatePostFields = (trimmedTitle: string, body: string): string | null => {
	if (trimmedTitle.length === 0) return postErrorMessage("TITLE_REQUIRED", "");
	if (trimmedTitle.length > TITLE_MAX) return postErrorMessage("TITLE_TOO_LONG", "");
	if (body.length > BODY_MAX) return postErrorMessage("BODY_TOO_LONG", "");
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
	const report = useReportHandler();

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
	} = useDraftSubmit({errorMessage: postErrorMessage, redirectPath: postRedirectPath});
	const {
		error: deleteError,
		inFlight: deleteInFlight,
		run: runDelete,
	} = useDraftSubmit({errorMessage: postErrorMessage, redirectPath: postRedirectPath});

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
		await runEdit(
			() =>
				fate.mutations.post.edit({
					input: {id: data.id, title: trimmedTitle, body: editBody},
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
	/** Parent post's canonical path; threaded into each node for its comment-anchor share URL. */
	postPath: string;
	signedIn: boolean;
	currentUserId: string | null;
}

/**
 * Resolves the `#comment-<id>` permalink anchor: returns the targeted comment id and
 * scrolls its node into view once it's rendered. Comments arrive async (fate connection),
 * so the native browser hash-jump misses — this re-tries on each thread change until the
 * `#comment-<id>` element exists, then scrolls it once.
 */
function useCommentAnchor(threadKey: number): string | null {
	const {hash} = useLocation();
	const activeId = hash.startsWith("#comment-") ? hash.slice("#comment-".length) : null;
	const scrolledFor = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (!activeId || scrolledFor.current === activeId) return;
		const el = document.getElementById(`comment-${activeId}`);
		if (!el) return;
		el.scrollIntoView({behavior: "smooth", block: "center"});
		scrolledFor.current = activeId;
	}, [activeId, threadKey]);

	return activeId;
}

function Comments(props: CommentsProps) {
	const post = useView(PostDetailView, props.post);
	const fate = useFateClient();
	const report = useReportHandler();
	const [items, loadNext] = useLiveListView(CommentConnectionView, post.comments);
	const activeCommentId = useCommentAnchor(items.length);

	const [replyTo, setReplyTo] = React.useState<string | null>(null);
	const [editingCommentId, setEditingCommentId] = React.useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
	const {
		error: deleteError,
		setError: setDeleteError,
		inFlight: deleteInFlight,
		run: runDelete,
	} = useDraftSubmit({
		errorMessage: commentErrorMessage,
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
	const navigate = useNavigate();
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

	React.useEffect(() => {
		if (autoFocus) textareaRef.current?.focus();
	}, [autoFocus]);

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody: "",
		validate: validateCommentBody,
		redirectPath: currentLocationPath,
		run: (value) =>
			fate.mutations.comment.add({
				input: {postId, body: value, ...(parentId ? {parentId} : {})},
				view: CommentTreeNodeView,
			}),
		errorMessage: commentErrorMessage,
		failureFallback: "yorum eklenemedi",
		onSuccess: () => {
			setBody("");
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
 * through `CommentTreeNodeView` (the view the node reads), so it re-renders in place.
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
	const localId = commentId;

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody,
		validate: validateCommentBody,
		redirectPath: currentLocationPath,
		run: (value) =>
			fate.mutations.comment.edit({input: {id: commentId, body: value}, view: CommentTreeNodeView}),
		errorMessage: commentErrorMessage,
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
