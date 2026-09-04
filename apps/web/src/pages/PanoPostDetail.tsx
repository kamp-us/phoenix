/**
 * Post-detail page. One batched `useRequest` resolves the header + first page of
 * comments; children mask their slice off the same refs — see
 * `.patterns/fate-connections.md` and `.patterns/fate-mutations-client.md`.
 */

import type {ReportOutcome} from "@kampus/design";
import {Alert, Button, Dialog, EmptyState, Input, Kbd, Textarea} from "@kampus/design";
import {toEntityId, type ViewData, type ViewEntity, type ViewSelection} from "@nkzw/fate";
import {ArrowLeft} from "lucide-react";
import * as React from "react";
import {useFateClient, useLiveListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link, useLocation, useNavigate, useParams} from "react-router";
import type {Post, ReportReceipt} from "../../worker/features/fate/views";
import {sandboxesNewContent} from "../../worker/features/kunye/standing";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {FirstContributionOnramp} from "../components/authorship/FirstContributionOnramp";
import {Icon} from "../components/Icon";
import {actorLabel} from "../components/moderation/actor-identity";
import {CommentTreeNode, CommentTreeNodeView} from "../components/pano/CommentTreeNode";
import {commentCountLabel} from "../components/pano/commentCount";
import {buildCommentTree, type CommentNode} from "../components/pano/commentTree";
import {
	PanoPostHeader,
	PanoPostHeaderView,
	PanoPostHeaderVote,
} from "../components/pano/PanoPostHeader";
import {PanoPostSkeleton} from "../components/pano/PanoSkeleton";
import {
	beginOptimisticCommentMembership,
	optimisticCommentRecord,
} from "../fate/optimisticCommentAdd";
import {beginOptimisticCommentDelete, decideCommentDelete} from "../fate/optimisticCommentDelete";
import {bodyEditOptimistic, postEditOptimistic} from "../fate/optimisticEdit";
import {Screen} from "../fate/Screen";
import {useDraft, useDraftSubmit} from "../fate/useDraftSubmit";
import {useConfirmGone, useReadbackRefetch} from "../fate/useReadbackRefetch";
import {codeOf, LoadMoreButton, toIsoOrNull} from "../fate/wire";
import {messageForCode, type WireMessageOverrides} from "../fate/wireMessages";
import {type Translate, useLocale, useT} from "../i18n";
import type {FateWireCode} from "../lib/fateWireCodes";
import {authRedirectPath} from "../lib/returnTo";
import {submitOnCmdEnter} from "../lib/submitShortcut";
import {NotFoundPage} from "./NotFoundPage";
import {decideOptimisticDelete} from "./optimisticPostDelete";
import "./PanoPostDetail.css";

const COMMENT_BODY_MAX = 5_000;
const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const PAGE_SIZE = 50;

// `append: "visible"` overrides fate's default `"edge"` buffering — see `.patterns/fate-live-views.md`.
const CommentConnectionView = {
	items: {node: CommentTreeNodeView},
	live: {append: "visible"},
} as const;

// Must stay exactly what `useView(CommentTreeNodeView, ref)` yields — the tree build
// reads it off each node ref synchronously via `client.readView`.
type CommentNodeData = ViewData<
	ViewEntity<typeof CommentTreeNodeView> & {__typename: "Comment"},
	ViewSelection<typeof CommentTreeNodeView>
>;

const PostDetailView = view<Post>()({
	...PanoPostHeaderView,
	comments: CommentConnectionView,
});

// A report has no read view, so `report.submit` returns this receipt; `created: false`
// is the idempotent re-report no-op.
const ReportReceiptView = view<ReportReceipt>()({
	id: true,
	created: true,
});

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

// Built per render rather than at module scope: every message is catalog copy now, and a
// module constant would freeze the locale the module was first evaluated under.
function postOverrides(t: Translate): WireMessageOverrides {
	return {
		TITLE_REQUIRED: t("pano.error.titleRequired"),
		TITLE_TOO_LONG: t("pano.error.titleTooLong", {max: TITLE_MAX}),
		BODY_TOO_LONG: t("pano.error.bodyTooLong", {max: BODY_MAX}),
		POST_NOT_FOUND: t("pano.error.postNotFound"),
	};
}

function commentOverrides(t: Translate): WireMessageOverrides {
	return {
		BODY_REQUIRED: t("pano.error.commentBodyRequired"),
		BODY_TOO_LONG: t("pano.error.commentBodyTooLong", {max: COMMENT_BODY_MAX}),
		COMMENT_NOT_FOUND: t("pano.error.commentNotFound"),
		PARENT_NOT_FOUND: t("pano.error.parentNotFound"),
	};
}

const currentLocationPath = () => `${window.location.pathname}${window.location.search}`;

const DELETE_ERROR_STATE_KEY = "postDeleteError";

function readDeleteError(state: unknown): string | null {
	if (state == null || typeof state !== "object") return null;
	const value = (state as Record<string, unknown>)[DELETE_ERROR_STATE_KEY];
	return typeof value === "string" ? value : null;
}

// Curried on the bound translate and the memoized override table: these are module-level rules,
// but the copy they resolve is locale-bound, so the component supplies both.
const commentBodyValidator =
	(t: Translate, overrides: WireMessageOverrides) =>
	(trimmed: string, body: string): string | null => {
		if (trimmed.length === 0) return messageForCode(t, "BODY_REQUIRED", overrides);
		if (body.length > COMMENT_BODY_MAX) return messageForCode(t, "BODY_TOO_LONG", overrides);
		return null;
	};

const validatePostFields = (
	t: Translate,
	overrides: WireMessageOverrides,
	trimmedTitle: string,
	body: string,
): string | null => {
	if (trimmedTitle.length === 0) return messageForCode(t, "TITLE_REQUIRED", overrides);
	if (trimmedTitle.length > TITLE_MAX) return messageForCode(t, "TITLE_TOO_LONG", overrides);
	if (body.length > BODY_MAX) return messageForCode(t, "BODY_TOO_LONG", overrides);
	return null;
};

export function PanoPostDetail() {
	const t = useT();
	const {id} = useParams<{id: string}>();
	const safeId = id ?? "";
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Link to="/pano" className="kp-pano-postpage__back">
					<Icon icon={ArrowLeft} size={14} />
					{t("pano.backToFeed")}
				</Link>
				<Screen
					fallback={<PanoPostSkeleton />}
					error={({code}) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							{t("pano.detail.loadFailed", {code: code.toLowerCase()})}
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
	const t = useT();
	const {post} = useRequest({
		post: {view: PostDetailView, args: {idOrSlug, comments: {first: PAGE_SIZE}}},
	});

	if (!post) {
		return (
			<NotFoundPage
				title={t("pano.error.postNotFound")}
				message={t("pano.detail.notFound.message", {query: idOrSlug})}
			/>
		);
	}

	return <PostContentInner post={post} idOrSlug={idOrSlug} />;
}

function PostContentInner({post, idOrSlug}: {post: ViewRef<"Post">; idOrSlug: string}) {
	const t = useT();
	const overrides = React.useMemo(() => postOverrides(t), [t]);
	const data = useView(PanoPostHeaderView, post);
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
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
	} = useDraftSubmit({overrides, redirectPath: postRedirectPath});
	const {error: deleteError, setError: setDeleteError} = useDraftSubmit({
		overrides,
		redirectPath: postRedirectPath,
	});

	// Optimistic delete navigates to /pano at once, so a rejection's inline error
	// can't stay on the unmounted dialog — the rollback returns here carrying the
	// message in router state (see `onDeleteConfirm`). Rehydrate it: reopen the
	// dialog with the error, then clear the state so a refresh/back can't re-trigger.
	React.useEffect(() => {
		const carried = readDeleteError(location.state);
		if (carried == null) return;
		setDeleteError(carried);
		setConfirmDelete(true);
		navigate(location.pathname, {replace: true, state: null});
	}, [location.state, location.pathname, navigate, setDeleteError]);

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
		const validationError = validatePostFields(t, overrides, trimmedTitle, editBody);
		if (validationError != null) {
			setEditError(validationError);
			return;
		}
		await runEdit(
			() =>
				fate.mutations.post.edit({
					input: {id: data.id, title: trimmedTitle, body: editBody},
					optimistic: postEditOptimistic({title: trimmedTitle, body: editBody}),
					view: PanoPostHeaderView,
				}),
			t("pano.detail.postUpdateFailed"),
			() => setEditing(false),
		);
	}

	async function onDeleteConfirm() {
		// fate applies `delete: true` synchronously, before the round-trip, so navigating
		// away immediately is safe; on rejection it restores the post and we navigate back
		// with the inline error. See `.patterns/fate-mutations-client.md`.
		setConfirmDelete(false);
		const promise = fate.mutations.post.delete({input: {id: data.id}, delete: true});
		const path = postRedirectPath();
		navigate("/pano");
		let failureCode: FateWireCode | null = null;
		try {
			const {error} = await promise;
			if (error) failureCode = codeOf(error);
		} catch (caught) {
			failureCode = codeOf(caught);
		}
		const outcome = decideOptimisticDelete(failureCode);
		if (outcome.kind === "deleted") return;
		if (outcome.kind === "auth-redirect") {
			navigate(authRedirectPath(path));
			return;
		}
		navigate(path, {
			state: {[DELETE_ERROR_STATE_KEY]: messageForCode(t, outcome.code, overrides)},
		});
	}

	return (
		<>
			<header className="kp-pano-postpage__head">
				<PanoPostHeaderVote post={post} isAuthor={isAuthor} />
				{editing ? (
					<form className="kp-pano-edit-post" onSubmit={onEditSubmit}>
						<Input
							className="kp-pano-edit-post__title"
							aria-label={t("pano.field.title")}
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							disabled={editInFlight}
							data-testid="post-edit-title"
							maxLength={TITLE_MAX + 50}
							fullWidth
						/>
						<Textarea
							className="kp-pano-edit-post__body"
							aria-label={t("pano.field.body")}
							value={editBody}
							onChange={(e) => setEditBody(e.target.value)}
							disabled={editInFlight}
							data-testid="post-edit-body"
							maxLength={BODY_MAX + 100}
							fullWidth
							resize="vertical"
						/>
						{editError ? (
							<Alert
								variant="danger"
								className="kp-alert--inline kp-pano-edit-post__error"
								data-testid="post-edit-error"
								style={{color: "var(--danger)", font: "var(--t-meta)"}}
							>
								{editError}
							</Alert>
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
								{t("pano.action.dismiss")}
							</Button>
							<Button
								variant="primary"
								size="sm"
								type="submit"
								disabled={editInFlight || editTitle.trim().length === 0}
								data-testid="post-edit-save"
							>
								{editInFlight ? t("pano.action.saving") : t("pano.action.save")}
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
				<Dialog
					open={confirmDelete}
					onOpenChange={setConfirmDelete}
					role="alertdialog"
					title={t("pano.detail.deletePost.title")}
					description={t("pano.detail.deletePost.description")}
					footer={({close}) => (
						<>
							<Button variant="tertiary" onClick={close}>
								{t("pano.action.cancel")}
							</Button>
							<Button
								variant="primary"
								type="button"
								data-testid="post-delete-confirm"
								onClick={onDeleteConfirm}
							>
								{t("pano.action.delete")}
							</Button>
						</>
					)}
				>
					{deleteError ? (
						<Alert
							variant="danger"
							className="kp-alert--inline"
							style={{color: "var(--danger)", font: "var(--t-meta)"}}
						>
							{deleteError}
						</Alert>
					) : null}
				</Dialog>
			) : null}

			<Comments
				post={post}
				postId={data.id}
				idOrSlug={idOrSlug}
				postPath={`/pano/${data.slug ?? data.id}`}
				signedIn={!!session.data?.user}
				currentUserId={session.data?.user?.id ?? null}
				currentUserName={
					session.data?.user ? actorLabel(session.data.user.name, null, t("pano.user")) : null
				}
			/>
		</>
	);
}

interface CommentsProps {
	post: ViewRef<"Post">;
	postId: string;
	idOrSlug: string;
	postPath: string;
	signedIn: boolean;
	currentUserId: string | null;
	currentUserName: string | null;
}

// A MutationObserver, not a retry keyed on `items.length`: a node mounts when its view
// snapshot fulfills, which is independent of list membership, so a reactive key can settle
// before the target exists and never re-fire (#649). A comment on a not-yet-paginated page
// is never in the DOM and so never scrolled to — an accepted limit.
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
	const {locale, t} = useLocale();
	const overrides = React.useMemo(() => commentOverrides(t), [t]);
	const post = useView(PostDetailView, props.post);
	const fate = useFateClient();
	const report = useReportHandler();
	const [items, loadNext] = useLiveListView(CommentConnectionView, post.comments);
	const activeCommentId = useCommentAnchor();

	const refetchPost = React.useCallback(
		() =>
			fate.request(
				{
					post: {
						view: PostDetailView,
						args: {idOrSlug: props.idOrSlug, comments: {first: PAGE_SIZE}},
					},
				},
				{mode: "network-only"},
			),
		[fate, props.idOrSlug],
	);

	// Deterministic read-back: if the server's `appendNode` push for the author's own
	// new comment is lost (publish-vs-register race, #714), refetch this page's request
	// `network-only` so the comment lands without a manual refresh.
	const confirmComment = useReadbackRefetch({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: refetchPost,
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
		overrides,
		redirectPath: () => `/pano/${props.postId}`,
	});

	// Read each node's masked data synchronously (no per-node hook) so the tree builds in
	// the same render the nodes arrive in; a not-yet-fulfilled node is skipped this frame.
	const {roots, childrenByParent, bodyById, refById, visibleCount, visibleIds, repliedToIds} =
		React.useMemo(() => {
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
			// The delete-side read-back watches this set: a hard delete drops the id from
			// membership, a soft delete tombstones it — either way it leaves here.
			const visibleIds = nodes.filter((n) => n.deletedAt == null).map((n) => n.id);
			// Every id some LOADED node names as its parent — the optimistic-delete branch
			// (ADR 0125) reads it to pick edge-drop vs tombstone. Deleted parents are
			// included so that branch mirrors the server's.
			const repliedToIds = new Set(
				nodes.map((n) => n.parentId).filter((id): id is string => id != null),
			);
			return {...buildCommentTree(nodes), visibleIds, repliedToIds};
		}, [items, fate]);

	// Delete-side twin of the read-back above: a lost `deleteEdge` push would otherwise
	// leave the deleted comment rendered forever (#1687).
	const confirmCommentGone = useConfirmGone({
		presentIds: visibleIds,
		refetch: refetchPost,
	});

	const childrenForId = React.useCallback(
		(id: string): ReadonlyArray<{id: string; ref: ViewRef<"Comment">}> =>
			childrenByParent.get(id) ?? [],
		[childrenByParent],
	);

	async function onDeleteConfirm() {
		if (!confirmDeleteId) return;
		const deletedId = confirmDeleteId;
		// `comment.delete` returns the re-resolved parent `Post` (leaf-hard-delete
		// vs parent-soft-delete-tombstone is the server's call), so we can't use
		// `delete: true`. The resolver drives the row live: hard delete → `deleteEdge`
		// (row drops), soft delete → `live.update` with the `[silindi]` tombstone.
		await runDelete(
			() => {
				const promise = fate.mutations.comment.delete({input: {id: deletedId}});
				// Mirror the server's branch from the loaded tree (ADR 0125): an empty reply set
				// only proves a leaf when `loadNext == null` (whole thread loaded); otherwise
				// tombstone, because the reply may sit on an unloaded page.
				const strategy = decideCommentDelete({
					hasLoadedReply: repliedToIds.has(deletedId),
					threadComplete: loadNext == null,
				});
				const rollback = beginOptimisticCommentDelete(fate.store, {
					strategy,
					commentId: deletedId,
					postId: props.postId,
					now: new Date(),
				});
				promise.then(
					(res) => {
						if (res.error) rollback();
					},
					() => rollback(),
				);
				return promise;
			},
			t("pano.detail.commentDeleteFailed"),
			() => {
				setConfirmDeleteId(null);
				confirmCommentGone(deletedId);
			},
		);
	}

	// Null unless the author identity is known — the temp node mirrors the author, so a
	// missing name/id degrades to the plain round-trip. `sandboxed` predicts the server's
	// create-time answer so a çaylak's comment never flashes as published (#4282).
	const {me} = useMe();
	const optimisticComment = React.useMemo(
		() =>
			props.currentUserId != null && props.currentUserName != null
				? {
						connection: post.comments,
						author: props.currentUserName,
						authorId: props.currentUserId,
						sandboxed: sandboxesNewContent(me?.tier),
					}
				: null,
		[post.comments, props.currentUserId, props.currentUserName, me?.tier],
	);

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
						optimistic={optimisticComment}
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
		[
			replyTo,
			editingCommentId,
			props.postId,
			props.signedIn,
			bodyById,
			refById,
			confirmComment,
			optimisticComment,
		],
	);

	return (
		<>
			{/* Top-level composer only, deliberately: the reply composer is the same component
			    rendered inline in a thread node, so mounting there would repeat the block at every
			    open reply box. One statement at the head of the thread frames both (#4283). */}
			<FirstContributionOnramp surface="pano-comment" />
			<CommentComposer
				postId={props.postId}
				parentId={null}
				signedIn={props.signedIn}
				onPosted={() => undefined}
				onConfirm={confirmComment}
				optimistic={optimisticComment}
			/>
			<h2 className="kp-pano-postpage__thread-heading">
				{commentCountLabel(t, locale, visibleCount)}
			</h2>
			{visibleCount === 0 ? (
				<EmptyState
					title={t("pano.detail.noComments.title")}
					description={t("pano.detail.noComments.description")}
				/>
			) : null}
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
			<Dialog
				open={confirmDeleteId != null}
				role="alertdialog"
				title={t("pano.detail.deleteComment.title")}
				description={t("pano.detail.deleteComment.description")}
				onOpenChange={(open) => {
					if (!open) {
						setConfirmDeleteId(null);
						setDeleteError(null);
					}
				}}
				footer={({close}) => (
					<>
						<Button variant="tertiary" onClick={close}>
							{t("pano.action.cancel")}
						</Button>
						<Button
							variant="primary"
							type="button"
							disabled={deleteInFlight}
							loading={deleteInFlight}
							data-testid="pano-comment-delete-confirm"
							onClick={onDeleteConfirm}
						>
							{deleteInFlight ? t("pano.action.deleting") : t("pano.action.delete")}
						</Button>
					</>
				)}
			>
				{deleteError ? (
					<Alert
						variant="danger"
						className="kp-alert--inline"
						style={{color: "var(--danger)", font: "var(--t-meta)"}}
					>
						{deleteError}
					</Alert>
				) : null}
			</Dialog>
		</>
	);
}

// Nested-connection membership is server-driven, so the thread updates off the
// `appendNode` push; the optimistic path (ADR 0125) only front-runs it. See
// `.patterns/fate-mutations-client.md`.
function CommentComposer({
	postId,
	parentId,
	signedIn,
	onPosted,
	onCancel,
	onConfirm,
	optimistic,
	autoFocus,
}: {
	postId: string;
	parentId: string | null;
	signedIn: boolean;
	onPosted: () => void;
	onCancel?: () => void;
	onConfirm?: (commentId: string) => void;
	optimistic?: {
		connection: unknown;
		author: string;
		authorId: string;
		sandboxed: boolean;
	} | null;
	autoFocus?: boolean;
}) {
	const {t} = useLocale();
	const overrides = React.useMemo(() => commentOverrides(t), [t]);
	const fate = useFateClient();
	const navigate = useNavigate();
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
	const createdId = React.useRef<string | null>(null);

	React.useEffect(() => {
		if (autoFocus) textareaRef.current?.focus();
	}, [autoFocus]);

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody: "",
		validate: commentBodyValidator(t, overrides),
		redirectPath: currentLocationPath,
		run: async (value) => {
			const optimisticRecord = optimistic
				? optimisticCommentRecord({
						postId,
						parentId,
						body: value,
						author: optimistic.author,
						authorId: optimistic.authorId,
						sandboxed: optimistic.sandboxed,
						now: new Date(),
					})
				: undefined;
			// Fire the mutation first: fate writes the temp record synchronously (before
			// the first await), so the nested-list append below points at a live record.
			const promise = fate.mutations.comment.add({
				input: {postId, body: value, ...(parentId ? {parentId} : {})},
				view: CommentTreeNodeView,
				...(optimisticRecord ? {optimistic: optimisticRecord} : {}),
			});
			const rollback =
				optimistic && optimisticRecord
					? // The temp id MUST be `toEntityId`-qualified: both reconcile paths key off the
						// qualified id, so a bare `optimistic:<ts>` neither rewrites nor dedups and
						// leaves a duplicated temp node (#1714).
						beginOptimisticCommentMembership(
							fate.store,
							optimistic.connection,
							postId,
							toEntityId("Comment", optimisticRecord.id),
						)
					: undefined;
			try {
				const {result, error: callError} = await promise;
				createdId.current = result?.id != null ? String(result.id) : null;
				// fate rolls the temp record back but not this nested membership, so both
				// failure paths have to undo it by hand or a phantom row is left behind.
				if (callError) rollback?.();
				return {error: callError};
			} catch (caught) {
				rollback?.();
				throw caught;
			}
		},
		overrides,
		failureFallback: t("pano.detail.commentAddFailed"),
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
			<Textarea
				ref={textareaRef}
				className="kp-pano-comment-composer__textarea"
				aria-label={parentId ? t("pano.field.reply") : t("pano.field.comment")}
				placeholder={
					signedIn ? t("pano.composer.placeholder") : t("pano.composer.signedOutPlaceholder")
				}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={submitOnCmdEnter}
				disabled={inFlight || !signedIn}
				data-testid={parentId ? `pano-comment-reply-input-${parentId}` : "pano-comment-input"}
				maxLength={COMMENT_BODY_MAX + 100}
				fullWidth
				resize="vertical"
			/>
			{error ? (
				<Alert
					variant="danger"
					className="kp-alert--inline"
					data-testid="pano-comment-error"
					style={{color: "var(--danger)", font: "var(--t-meta)"}}
				>
					{error}
				</Alert>
			) : null}
			<div className="kp-pano-comment-composer__foot">
				<span className="kp-pano-comment-composer__hint">
					{t("pano.markdown")} · <Kbd>⌘</Kbd>+<Kbd>↵</Kbd>
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
							{t("pano.action.dismiss")}
						</Button>
					) : null}
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={inFlight || body.trim().length === 0}
						data-testid={parentId ? `pano-comment-reply-submit-${parentId}` : "pano-comment-submit"}
					>
						{inFlight
							? t("pano.action.sending")
							: parentId
								? t("pano.action.reply")
								: t("pano.composer.submit")}
					</Button>
				</div>
			</div>
		</form>
	);
}

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
	const t = useT();
	const overrides = React.useMemo(() => commentOverrides(t), [t]);
	const fate = useFateClient();
	const localId = commentId;

	const {body, setBody, error, inFlight, submit} = useDraft({
		initialBody,
		validate: commentBodyValidator(t, overrides),
		redirectPath: currentLocationPath,
		run: (value) =>
			fate.mutations.comment.edit({
				input: {id: commentId, body: value},
				optimistic: bodyEditOptimistic(value),
				view: CommentTreeNodeView,
			}),
		overrides,
		failureFallback: t("pano.detail.commentUpdateFailed"),
		onSuccess: onEdited,
	});

	return (
		<form
			className="kp-pano-comment-composer"
			onSubmit={submit}
			data-testid={`pano-comment-edit-form-${localId}`}
		>
			<Textarea
				className="kp-pano-comment-composer__textarea"
				aria-label={t("pano.detail.editComment.label")}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={submitOnCmdEnter}
				disabled={inFlight}
				data-testid={`pano-comment-edit-input-${localId}`}
				maxLength={COMMENT_BODY_MAX + 100}
				fullWidth
				resize="vertical"
			/>
			{error ? (
				<Alert
					variant="danger"
					className="kp-alert--inline"
					data-testid={`pano-comment-edit-error-${localId}`}
					style={{color: "var(--danger)", font: "var(--t-meta)"}}
				>
					{error}
				</Alert>
			) : null}
			<div className="kp-pano-comment-composer__foot">
				<span className="kp-pano-comment-composer__hint">
					{t("pano.markdown")} · <Kbd>⌘</Kbd>+<Kbd>↵</Kbd>
				</span>
				<div style={{display: "flex", gap: 6}}>
					<Button variant="tertiary" size="sm" type="button" onClick={onCancel} disabled={inFlight}>
						{t("pano.action.dismiss")}
					</Button>
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={inFlight || body.trim().length === 0}
						data-testid={`pano-comment-edit-save-${localId}`}
					>
						{inFlight ? t("pano.action.saving") : t("pano.action.save")}
					</Button>
				</div>
			</div>
		</form>
	);
}
