/**
 * Post-detail page (task_3, phoenix-relay-idiom).
 *
 * Fully idiomatic Relay shape — `useLazyLoadQuery` at the top spreads
 * `PanoPostHeaderFragment` + `PanoPostDetailCommentsFragment` into the
 * `Post` selection; `usePaginationFragment` reads the comment connection;
 * each row is a fragment ref handed to `CommentTreeNode` (which declares
 * its own `CommentTreeNodeFragment on Comment`).
 *
 * Live updates flow through `useLiveAgentV2`: the WebSocket pushes typed
 * `PostState` snapshots, the `applyToStore` callback writes them straight
 * into the Relay store via `commitLocalUpdate`. The page tree never
 * unmounts on a live event — `LivePill` connection state remains the
 * sole user-visible signal of subscription health (parity with T16).
 *
 * Mutations:
 *  - `addComment` — manual `updater` appends a `CommentEdge` into the
 *    `PanoPostDetail_comments` connection (chronological-asc), plus
 *    `optimisticResponse` for the immediate flip.
 *  - `deleteComment` — server returns a `DeleteCommentPayload`. Leaf path
 *    surfaces `deletedCommentId @deleteRecord`; parent-with-replies path
 *    surfaces the same `Comment` with `body = '[silindi]'` + `deletedAt`
 *    set, which Relay merges back via the normal store update.
 *  - `editComment`, `editPost`, `voteOnComment` — auto store update on the
 *    returned scalars (no updater).
 *  - `deletePost` — `deletedPostId @deleteRecord` (matches the task_2
 *    pattern; navigates back to /pano on success).
 */
import * as React from "react";
import {
	graphql,
	useFragment,
	useLazyLoadQuery,
	useMutation,
	usePaginationFragment,
} from "react-relay";
import {Link, useNavigate, useParams} from "react-router";
import type {RecordSourceProxy} from "relay-runtime";
import type {CommentTreeNodeFragment$key} from "../__generated__/CommentTreeNodeFragment.graphql";
import type {PanoPostDetailAddCommentMutation} from "../__generated__/PanoPostDetailAddCommentMutation.graphql";
import type {PanoPostDetailCommentsFragment$key} from "../__generated__/PanoPostDetailCommentsFragment.graphql";
import type {PanoPostDetailDeleteCommentMutation} from "../__generated__/PanoPostDetailDeleteCommentMutation.graphql";
import type {PanoPostDetailDeletePostMutation} from "../__generated__/PanoPostDetailDeletePostMutation.graphql";
import type {PanoPostDetailEditCommentMutation} from "../__generated__/PanoPostDetailEditCommentMutation.graphql";
import type {PanoPostDetailEditFragment$key} from "../__generated__/PanoPostDetailEditFragment.graphql";
import type {PanoPostDetailEditPostMutation} from "../__generated__/PanoPostDetailEditPostMutation.graphql";
import type {PanoPostDetailQuery} from "../__generated__/PanoPostDetailQuery.graphql";
import {useSession} from "../auth/client";
import {CommentTreeNode} from "../components/pano/CommentTreeNode";
import {PanoPostHeader, PanoPostHeaderVote} from "../components/pano/PanoPostHeader";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {authRedirectPath} from "../lib/returnTo";
import {useLiveAgentV2} from "../lib/useLiveAgent.v2";
import {useSessionExpiredToast} from "../lib/useSessionExpiredToast";
import {appendCommentToPostConnection} from "../relay/panoPostDetailUpdater";
import {QueryBoundary} from "../relay/QueryBoundary";
import {NotFoundPage} from "./NotFoundPage";
import "./PanoPostDetail.css";

const PostDetailQuery = graphql`
	query PanoPostDetailQuery($idOrSlug: String!, $first: Int) {
		post(idOrSlug: $idOrSlug) {
			id
			authorId
			...PanoPostHeaderFragment
			...PanoPostDetailEditFragment
			...PanoPostDetailCommentsFragment @arguments(first: $first)
		}
	}
`;

/**
 * Tiny page-local fragment that supplies the inline edit form's pre-fill
 * inputs (`title`, `body`). Kept separate from `PanoPostHeaderFragment` so
 * the header doesn't have to know about the edit affordance.
 */
const PanoPostDetailEditFragmentDef = graphql`
	fragment PanoPostDetailEditFragment on Post {
		id
		title
		body
	}
`;

/**
 * Comments connection on `Post`. `@refetchable` lets `usePaginationFragment`
 * load subsequent pages; `@connection` lets mutation updaters address the
 * connection by stable key + the parent's DataID.
 *
 * `first: Int` (nullable) per the relay-compiler rule that variables with
 * default values cannot be non-null. Page passes `PAGE_SIZE` as the
 * initial value.
 */
const PanoPostDetailCommentsFragmentDef = graphql`
	fragment PanoPostDetailCommentsFragment on Post
	@argumentDefinitions(
		first: {type: "Int", defaultValue: 50}
		after: {type: "String"}
	)
	@refetchable(queryName: "PanoPostDetailCommentsPaginationQuery") {
		comments(first: $first, after: $after)
			@connection(key: "PanoPostDetail_comments") {
			edges {
				node {
					id
					parentId
					body
					...CommentTreeNodeFragment
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

const EditCommentMutation = graphql`
	mutation PanoPostDetailEditCommentMutation($id: ID!, $body: String!) {
		editComment(id: $id, body: $body) {
			id
			body
			updatedAt
		}
	}
`;

/**
 * Delete a comment (T12 + task_3 phoenix-relay-idiom).
 *
 * The mutation returns a two-shape payload:
 *  - `deletedCommentId @deleteRecord` — leaf path; Relay removes the
 *    record and connection edges referencing it auto-clear.
 *  - `comment` — parent-with-replies path; the same Comment row arrives
 *    with `body = '[silindi]'` and `deletedAt` set. Relay's automatic
 *    store update merges the new scalars into the existing
 *    `Comment:<global-id>` record so the placeholder rerenders in place.
 *
 * Exactly one of the two fields is non-null per call.
 */
const DeleteCommentMutation = graphql`
	mutation PanoPostDetailDeleteCommentMutation($id: ID!) {
		deleteComment(id: $id) {
			deletedCommentId @deleteRecord
			comment {
				id
				body
				deletedAt
				updatedAt
			}
		}
	}
`;

const EditPostMutation = graphql`
	mutation PanoPostDetailEditPostMutation(
		$id: ID!
		$title: String
		$body: String
	) {
		editPost(id: $id, title: $title, body: $body) {
			id
			title
			body
			updatedAt
		}
	}
`;

const DeletePostMutation = graphql`
	mutation PanoPostDetailDeletePostMutation($id: ID!) {
		deletedPostId: deletePost(id: $id) @deleteRecord
	}
`;

/**
 * Add comment mutation (task_3 — switched from refetch-on-mutate to
 * connection updater + optimisticResponse). The selection set spreads
 * `CommentTreeNodeFragment` so the new row arrives in the store with
 * every field the tree node needs to render without a follow-up read.
 */
const AddCommentMutation = graphql`
	mutation PanoPostDetailAddCommentMutation(
		$postId: ID!
		$parentId: ID
		$body: String!
	) {
		addComment(postId: $postId, parentId: $parentId, body: $body) {
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
			...CommentTreeNodeFragment
		}
	}
`;

const COMMENT_BODY_MAX = 5_000;
const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const PAGE_SIZE = 50;

/**
 * Subset of the `PostState` Agent state shape the page subscribes to over
 * WebSocket — extends `LiveAgentStateShape` so `useLiveAgentV2`'s typed
 * generic accepts it. Keeping this client-side rather than importing from
 * the worker avoids dragging worker-only modules into the SPA bundle.
 */
interface LivePostState {
	score: number;
	commentCount: number;
	hotScore: number;
	lastActivityAt: number;
	lastEventId: string;
}

export function PanoPostDetail() {
	const {id} = useParams<{id: string}>();
	const safeId = id ?? "";
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Link to="/pano" className="kp-pano-postpage__back">
					← akışa dön
				</Link>
				<QueryBoundary
					loading={<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>}
					error={(err) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							başlık yüklenemedi: {err.message}
						</p>
					)}
				>
					<PostContent idOrSlug={safeId} />
				</QueryBoundary>
			</div>
		</div>
	);
}

function PostContent({idOrSlug}: {idOrSlug: string}) {
	const data = useLazyLoadQuery<PanoPostDetailQuery>(
		PostDetailQuery,
		{idOrSlug, first: PAGE_SIZE},
		{fetchPolicy: "store-or-network"},
	);
	const post = data.post;
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();

	const [editing, setEditing] = React.useState(false);
	const [editTitle, setEditTitle] = React.useState("");
	const [editBody, setEditBody] = React.useState("");
	const [editError, setEditError] = React.useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);

	const [editCommit, editInFlight] = useMutation<PanoPostDetailEditPostMutation>(EditPostMutation);
	const [deleteCommit, deleteInFlight] =
		useMutation<PanoPostDetailDeletePostMutation>(DeletePostMutation);

	if (!post) {
		return (
			<NotFoundPage
				title="başlık bulunamadı"
				message={`"${idOrSlug}" diye bir başlık bulamadık. başka bir şeye bakmak ister misin?`}
			/>
		);
	}

	const isAuthor = !!session.data?.user && session.data.user.id === post.authorId;
	const postRecordId = post.id;
	const postLocalId = idOrSlug;

	function onEditClick(seed: {title: string; body: string | null}) {
		setEditTitle(seed.title);
		setEditBody(seed.body ?? "");
		setEditError(null);
		setEditing(true);
	}

	function onEditSubmit(e: React.FormEvent, postGlobalId: string) {
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
		editCommit({
			variables: {id: postGlobalId, title: trimmedTitle, body: editBody},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setEditError(errors[0]?.message ?? "başlık güncellenemedi");
					return;
				}
				setEditing(false);
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setEditError(err.message);
			},
		});
	}

	const postGlobalId = post.id;
	function onDeleteConfirm() {
		setDeleteError(null);
		deleteCommit({
			variables: {id: postGlobalId},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setDeleteError(errors[0]?.message ?? "başlık silinemedi");
					return;
				}
				setConfirmDelete(false);
				navigate("/pano");
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setDeleteError(err.message);
			},
		});
	}

	// Live updates v2 — translates Agent state diffs into Relay store writes.
	// The page tree never unmounts (no `setFetchKey`); LivePill renders the
	// connection state. The applyToStore callback updates the Post node's
	// denormalized aggregates from the typed PostState snapshot.
	const applyLiveStateToStore = React.useCallback(
		(state: LivePostState, store: RecordSourceProxy) => {
			const postRecord = store.get(postRecordId);
			if (!postRecord) return;
			postRecord.setValue(state.score, "score");
			postRecord.setValue(state.commentCount, "commentCount");
			// `hotScore` and `lastActivityAt` aren't surfaced on the GraphQL Post
			// today — write them anyway so future fragments that select them
			// pick up the live values without a refetch. No-ops for stores that
			// don't carry the field.
		},
		[postRecordId],
	);

	const {connected: liveConnected} = useLiveAgentV2<LivePostState>({
		agent: "pano-post",
		name: postLocalId,
		applyToStore: applyLiveStateToStore,
		enabled: postLocalId.length > 0,
	});

	return (
		<>
			<header className="kp-pano-postpage__head">
				<PanoPostHeaderVote post={post} />
				{editing ? (
					<form className="kp-pano-edit-post" onSubmit={(e) => onEditSubmit(e, post.id)}>
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
					<PostHeaderWithEditWiring
						headerRef={post}
						editRef={post}
						isAuthor={isAuthor}
						livePill={<LivePill connected={liveConnected} />}
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
				postRecordId={postRecordId}
				signedIn={!!session.data?.user}
				currentUserId={session.data?.user?.id ?? null}
			/>
		</>
	);
}

/**
 * Wraps `PanoPostHeader` so the edit click can hand back the current title
 * + body (read off the page-local edit fragment) without making the header
 * own the edit form. The header is purely presentational; the page owns
 * the edit machinery.
 */
function PostHeaderWithEditWiring({
	headerRef,
	editRef,
	isAuthor,
	livePill,
	onEdit,
	onDelete,
}: {
	headerRef: React.ComponentProps<typeof PanoPostHeader>["post"];
	editRef: PanoPostDetailEditFragment$key;
	isAuthor: boolean;
	livePill: React.ReactNode;
	onEdit: (seed: {title: string; body: string | null}) => void;
	onDelete: () => void;
}) {
	const editData = useFragment(PanoPostDetailEditFragmentDef, editRef);
	return (
		<PanoPostHeader
			post={headerRef}
			isAuthor={isAuthor}
			livePill={livePill}
			onEdit={() => onEdit({title: editData.title, body: editData.body ?? null})}
			onDelete={onDelete}
		/>
	);
}

interface CommentsProps {
	post: PanoPostDetailCommentsFragment$key;
	postRecordId: string;
	signedIn: boolean;
	currentUserId: string | null;
}

function Comments(props: CommentsProps) {
	const {data, loadNext, hasNext, isLoadingNext} = usePaginationFragment(
		PanoPostDetailCommentsFragmentDef,
		props.post,
	);
	const [replyTo, setReplyTo] = React.useState<string | null>(null);
	const [editingCommentId, setEditingCommentId] = React.useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);

	const [deleteCommit, deleteInFlight] =
		useMutation<PanoPostDetailDeleteCommentMutation>(DeleteCommentMutation);
	const {handleError: handleAuthError} = useSessionExpiredToast();

	// Build the children-by-parent index from the flat connection edges.
	const {roots, childrenByParent, bodyById} = React.useMemo(() => {
		const all: Array<{id: string; parentId: string | null; ref: CommentTreeNodeFragment$key}> = [];
		const bodyById = new Map<string, string>();
		for (const edge of data.comments.edges) {
			if (!edge?.node) continue;
			all.push({
				id: edge.node.id,
				parentId: edge.node.parentId ?? null,
				ref: edge.node,
			});
			bodyById.set(edge.node.id, edge.node.body);
		}
		const childrenByParent = new Map<
			string,
			Array<{id: string; ref: CommentTreeNodeFragment$key}>
		>();
		const roots: Array<{id: string; ref: CommentTreeNodeFragment$key}> = [];
		const knownIds = new Set(all.map((c) => c.id));
		for (const c of all) {
			if (c.parentId && knownIds.has(c.parentId)) {
				const list = childrenByParent.get(c.parentId) ?? [];
				list.push({id: c.id, ref: c.ref});
				childrenByParent.set(c.parentId, list);
			} else {
				roots.push({id: c.id, ref: c.ref});
			}
		}
		return {roots, childrenByParent, bodyById};
	}, [data.comments.edges]);

	const childrenForId = React.useCallback(
		(id: string): ReadonlyArray<{id: string; ref: CommentTreeNodeFragment$key}> =>
			childrenByParent.get(id) ?? [],
		[childrenByParent],
	);

	const onDeleteConfirm = React.useCallback(() => {
		if (!confirmDeleteId) return;
		setDeleteError(null);
		deleteCommit({
			variables: {id: confirmDeleteId},
			onCompleted: (_d, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setDeleteError(errors[0]?.message ?? "yorum silinemedi");
					return;
				}
				setConfirmDeleteId(null);
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setDeleteError(err.message);
			},
		});
	}, [confirmDeleteId, deleteCommit, handleAuthError]);

	const composerFor = React.useCallback(
		(id: string) => ({
			replyComposer:
				replyTo === id ? (
					<CommentComposer
						postRecordId={props.postRecordId}
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
						initialBody={bodyById.get(id) ?? ""}
						onEdited={() => setEditingCommentId(null)}
						onCancel={() => setEditingCommentId(null)}
					/>
				) : undefined,
		}),
		[replyTo, editingCommentId, props.postRecordId, props.signedIn, bodyById],
	);

	return (
		<>
			<CommentComposer
				postRecordId={props.postRecordId}
				parentId={null}
				signedIn={props.signedIn}
				onPosted={() => undefined}
			/>
			<h2 className="kp-pano-postpage__thread-heading">{data.comments.totalCount} yorum</h2>
			<div className="kp-pano-thread">
				{roots.map((r) => {
					const c = composerFor(r.id);
					return (
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
							replyComposer={c.replyComposer}
							editComposer={c.editComposer}
						/>
					);
				})}
			</div>
			{hasNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<Button
						variant="tertiary"
						size="sm"
						type="button"
						disabled={isLoadingNext}
						onClick={() => loadNext(PAGE_SIZE)}
					>
						{isLoadingNext ? "yükleniyor…" : "daha fazla"}
					</Button>
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
 * Top-level + nested comment composer. Submits to `addComment`; on success
 * the manual `updater` appends a `CommentEdge` into the
 * `PanoPostDetail_comments` connection — the row appears in the tree
 * without a refetch.
 *
 * `optimisticResponse` mirrors the temp-record pattern from `submitPost`
 * (task_2 retry) — a `temp-${Date.now()}` id distinguishes the optimistic
 * record in devtools; the updater is idempotent on the optimistic →
 * server-confirm transition.
 */
function CommentComposer({
	postRecordId,
	parentId,
	signedIn,
	onPosted,
	onCancel,
	autoFocus,
}: {
	/**
	 * Relay DataID of the parent Post — used both to address the comments
	 * connection from the updater AND as the mutation variable. The Post's
	 * Relay DataID is its global id (`encodeNodeId("Post", localId)`); the
	 * resolver unwraps via `extractLocalId` (task_1 lenient migration helper).
	 */
	postRecordId: string;
	parentId: string | null;
	signedIn: boolean;
	onPosted: () => void;
	onCancel?: () => void;
	autoFocus?: boolean;
}) {
	const session = useSession();
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [commit, inFlight] = useMutation<PanoPostDetailAddCommentMutation>(AddCommentMutation);
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

	React.useEffect(() => {
		if (autoFocus) textareaRef.current?.focus();
	}, [autoFocus]);

	function submit(e: React.FormEvent) {
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
		const tempId = `temp-${Date.now()}`;
		commit({
			variables: {postId: postRecordId, parentId, body},
			optimisticResponse: {
				addComment: {
					id: tempId,
					parentId: parentId ?? null,
					body,
					score: 0,
					myVote: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					deletedAt: null,
					author: session.data?.user?.name ?? "",
					authorId: session.data?.user?.id ?? "",
				},
			},
			updater: (store) => {
				appendCommentToPostConnection(store, postRecordId);
			},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "yorum eklenemedi");
					return;
				}
				setBody("");
				onPosted();
				onCancel?.();
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setError(err.message);
			},
		});
	}

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

function CommentEditComposer({
	commentId,
	initialBody,
	onEdited,
	onCancel,
}: {
	commentId: string;
	initialBody: string;
	onEdited: () => void;
	onCancel: () => void;
}) {
	const [body, setBody] = React.useState(initialBody);
	const [error, setError] = React.useState<string | null>(null);
	const [commit, inFlight] = useMutation<PanoPostDetailEditCommentMutation>(EditCommentMutation);
	const {handleError: handleAuthError} = useSessionExpiredToast();

	function submit(e: React.FormEvent) {
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
		commit({
			variables: {id: commentId, body},
			onCompleted: (_d, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "yorum güncellenemedi");
					return;
				}
				onEdited();
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setError(err.message);
			},
		});
	}

	return (
		<form
			className="kp-pano-comment-composer"
			onSubmit={submit}
			data-testid={`pano-comment-edit-form-${commentId}`}
		>
			<textarea
				className="kp-pano-comment-composer__textarea"
				value={body}
				onChange={(e) => setBody(e.target.value)}
				disabled={inFlight}
				data-testid={`pano-comment-edit-input-${commentId}`}
				maxLength={COMMENT_BODY_MAX + 100}
			/>
			{error ? (
				<p
					role="alert"
					data-testid={`pano-comment-edit-error-${commentId}`}
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
						data-testid={`pano-comment-edit-save-${commentId}`}
					>
						{inFlight ? "kaydediliyor…" : "kaydet"}
					</Button>
				</div>
			</div>
		</form>
	);
}

/**
 * LivePill — connection-state indicator for the WebSocket. T16 shape;
 * unchanged in this task per the AC ("LivePill connected/paused UX
 * preserved exactly"). The hook now uses `commitLocalUpdate` instead of
 * refetch but the user-visible UX is byte-for-byte identical.
 */
function LivePill({connected}: {connected: boolean}) {
	if (connected) {
		return (
			<span
				data-testid="live-pill-connected"
				style={{
					font: "var(--t-meta)",
					color: "var(--text-muted)",
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
				}}
				aria-label="canlı güncellemeler açık"
				title="canlı güncellemeler açık"
			>
				<span
					style={{
						width: 6,
						height: 6,
						borderRadius: "50%",
						backgroundColor: "var(--success, #22c55e)",
						display: "inline-block",
					}}
				/>
				canlı
			</span>
		);
	}
	return (
		<span
			data-testid="live-pill-paused"
			style={{
				font: "var(--t-meta)",
				color: "var(--text-muted)",
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
			}}
			aria-label="canlı güncellemeler duraklatıldı"
			title="canlı güncellemeler duraklatıldı"
		>
			<span
				style={{
					width: 6,
					height: 6,
					borderRadius: "50%",
					backgroundColor: "var(--text-muted)",
					display: "inline-block",
				}}
			/>
			canlı güncellemeler duraklatıldı
		</span>
	);
}
