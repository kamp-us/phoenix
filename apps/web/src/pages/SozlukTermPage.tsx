import * as React from "react";
import {graphql, useLazyLoadQuery, useMutation} from "react-relay";
import {Link, useNavigate, useParams} from "react-router";
import type {SozlukTermPageAddDefinitionMutation} from "../__generated__/SozlukTermPageAddDefinitionMutation.graphql";
import type {SozlukTermPageDeleteDefinitionMutation} from "../__generated__/SozlukTermPageDeleteDefinitionMutation.graphql";
import type {SozlukTermPageEditDefinitionMutation} from "../__generated__/SozlukTermPageEditDefinitionMutation.graphql";
import type {SozlukTermPageQuery} from "../__generated__/SozlukTermPageQuery.graphql";
import type {SozlukTermPageRetractVoteMutation} from "../__generated__/SozlukTermPageRetractVoteMutation.graphql";
import type {SozlukTermPageVoteMutation} from "../__generated__/SozlukTermPageVoteMutation.graphql";
import {useSession} from "../auth/client";
import {Button} from "../components/ui/Button";
import {Dialog} from "../components/ui/Dialog";
import {EditedIndicator} from "../components/ui/EditedIndicator";
import {formatAgoTR, formatDateTR} from "../lib/datetime";
import {renderMarkdownInline, splitMarkdownBlocks} from "../lib/markdown";
import {authRedirectPath} from "../lib/returnTo";
import {useLiveAgent} from "../lib/useLiveAgent";
import {useSessionExpiredToast} from "../lib/useSessionExpiredToast";
import {QueryBoundary} from "../relay/QueryBoundary";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const TermQuery = graphql`
  query SozlukTermPageQuery($slug: String!) {
    term(slug: $slug) {
      id
      slug
      title
      count
      totalScore
      firstAt
      lastEdit
      definitions {
        id
        body
        author
        authorId
        score
        myVote
        createdAt
        updatedAt
      }
    }
  }
`;

type TermNode = NonNullable<SozlukTermPageQuery["response"]["term"]>;
type DefinitionNode = TermNode["definitions"][number];

export function SozlukTermPage() {
	const {slug} = useParams<{slug: string}>();
	const safeSlug = slug ?? "";
	/* Bumped on every successful addDefinition mutation; forces useLazyLoadQuery
     to re-fetch so the freshly added definition appears in the list. */
	const [fetchKey, setFetchKey] = React.useState(0);

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<QueryBoundary
					loading={<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>}
					error={(err) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							terim yüklenemedi: {err.message}
						</p>
					)}
				>
					<SozlukTermContent
						slug={safeSlug}
						fetchKey={fetchKey}
						onMutated={() => setFetchKey((k) => k + 1)}
					/>
				</QueryBoundary>
			</div>
		</div>
	);
}

function SozlukTermContent({
	slug,
	fetchKey,
	onMutated,
}: {
	slug: string;
	fetchKey: number;
	onMutated: () => void;
}) {
	// Live subscription to SozlukTerm[slug] over WebSocket (T16). On every
	// `setState` server-side (vote, edit, delete, add), `liveSignal` bumps
	// and we tack it onto the Relay `fetchKey` so the term query refetches.
	// `connected` drives the "canlı güncellemeler duraklatıldı" pill — flips
	// off on disconnect / sign-out / network blip.
	const {liveSignal, connected: liveConnected} = useLiveAgent({
		agent: "sozluk-term",
		name: slug,
		enabled: slug.length > 0,
	});

	// Combined refetch key. `store-and-network` keeps the existing data
	// rendered while a fresh fetch is in flight — Suspense won't re-suspend
	// when the cached payload is present, so the live refresh feels smooth
	// instead of flashing the page-level "yükleniyor…" boundary.
	const combinedKey = fetchKey + liveSignal;
	const data = useLazyLoadQuery<SozlukTermPageQuery>(
		TermQuery,
		{slug},
		{
			fetchKey: combinedKey,
			fetchPolicy: combinedKey === 0 ? "store-or-network" : "store-and-network",
		},
	);
	const term = data.term;
	const session = useSession();
	const signedIn = !!session.data?.user;

	if (!term) {
		// Signed-out viewers can't auto-create a term — render the shared 404
		// so the absence is unambiguous. Signed-in viewers get the composer
		// branch below so the first definition lands and auto-creates the term
		// (T4's contract).
		if (!signedIn) {
			return (
				<NotFoundPage
					title="terim bulunamadı"
					message={`"${slug}" diye bir terim henüz yok. giriş yapıp ilk tanımı sen yazabilirsin.`}
				/>
			);
		}
		/* Slug doesn't exist yet — show the composer so the first definition
       creates both the term and the entry. Same auto-create-term contract
       enforced server-side by SozlukTerm.addDefinition (task_4). */
		return (
			<>
				<header className="kp-sozluk-term__head">
					<p className="kp-sozluk-term__crumbs">
						<Link to="/sozluk">sözlük</Link> /{" "}
						<Link to="/sozluk">{slug.charAt(0).toLowerCase()}</Link> / {slug.replace(/-/g, " ")}
					</p>
					<h1 className="kp-sozluk-term__title">{slug.replace(/-/g, " ")}</h1>
					<div className="kp-sozluk-term__meta">
						<span>henüz tanım yok</span>
						<LivePill connected={liveConnected} />
					</div>
				</header>
				<p style={{font: "var(--t-body)", color: "var(--text-muted)"}}>
					"{slug}" terimi henüz yok. ilk tanımı sen yazabilirsin.
				</p>
				<Composer slug={slug} onAdded={onMutated} />
			</>
		);
	}

	const firstLetter = term.title.charAt(0).toLowerCase();

	return (
		<>
			<header className="kp-sozluk-term__head">
				<p className="kp-sozluk-term__crumbs">
					<Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> / {term.title}
				</p>
				<h1 className="kp-sozluk-term__title">{term.title}</h1>
				<div className="kp-sozluk-term__meta">
					<span>{term.count} tanım</span>
					<span>{term.totalScore} oy</span>
					{term.firstAt ? <span>ilk: {formatDateTR(term.firstAt)}</span> : null}
					{term.lastEdit ? <span>son düzenleme: {formatAgoTR(term.lastEdit)}</span> : null}
					<LivePill connected={liveConnected} />
				</div>
			</header>

			{term.definitions.map((d, i) => (
				<DefinitionCard
					key={d.id}
					definition={d}
					rank={i + 1}
					top={i === 0}
					slug={slug}
					onMutated={onMutated}
				/>
			))}

			<Composer slug={slug} onAdded={onMutated} />
		</>
	);
}

/**
 * Single-definition vote mutation. Relay's optimistic updater flips
 * `myVote` and `score` synchronously so the UI feels instantaneous; the
 * server response either confirms (no visible change) or — on failure —
 * Relay rolls back to the pre-mutation values automatically.
 */
const VoteDefinitionMutation = graphql`
  mutation SozlukTermPageVoteMutation($definitionId: ID!) {
    voteDefinition(definitionId: $definitionId) {
      id
      score
      myVote
    }
  }
`;

const RetractDefinitionVoteMutation = graphql`
  mutation SozlukTermPageRetractVoteMutation($definitionId: ID!) {
    retractDefinitionVote(definitionId: $definitionId) {
      id
      score
      myVote
    }
  }
`;

/**
 * Edit mutation for definitions (T6). Returns the updated body + updatedAt so
 * Relay can write the change into the store keyed by `id` without a refetch.
 */
const EditDefinitionMutation = graphql`
  mutation SozlukTermPageEditDefinitionMutation($id: ID!, $body: String!) {
    editDefinition(id: $id, body: $body) {
      id
      body
      score
      updatedAt
    }
  }
`;

/**
 * Delete (soft-delete) mutation for definitions (T6). Returns the deleted id
 * as a stable token; the parent re-fetches the term query to drop the row
 * from the rendered list.
 */
const DeleteDefinitionMutation = graphql`
  mutation SozlukTermPageDeleteDefinitionMutation($id: ID!) {
    deleteDefinition(id: $id)
  }
`;

function DefinitionCard({
	definition,
	rank,
	top,
	slug,
	onMutated,
}: {
	definition: DefinitionNode;
	rank: number;
	top: boolean;
	slug: string;
	onMutated: () => void;
}) {
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const [voteCommit, voteInFlight] =
		useMutation<SozlukTermPageVoteMutation>(VoteDefinitionMutation);
	const [retractCommit, retractInFlight] = useMutation<SozlukTermPageRetractVoteMutation>(
		RetractDefinitionVoteMutation,
	);
	const [editCommit, editInFlight] = useMutation<SozlukTermPageEditDefinitionMutation>(
		EditDefinitionMutation,
	);
	const [deleteCommit, deleteInFlight] = useMutation<SozlukTermPageDeleteDefinitionMutation>(
		DeleteDefinitionMutation,
	);

	const [editing, setEditing] = React.useState(false);
	const [editBody, setEditBody] = React.useState(definition.body);
	const [editError, setEditError] = React.useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);

	const inFlight = voteInFlight || retractInFlight;
	const voted = (definition.myVote ?? 0) === 1;
	const cls = top ? "kp-sozluk-definition kp-sozluk-definition--top" : "kp-sozluk-definition";
	const isAuthor = !!session.data?.user && session.data.user.id === definition.authorId;

	function onVoteClick() {
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${slug}`));
			return;
		}
		if (inFlight) return;
		if (voted) {
			retractCommit({
				variables: {definitionId: definition.id},
				/* Optimistic flip: vote off, score -1 right now. Relay rolls
				   back automatically if the mutation rejects. */
				optimisticResponse: {
					retractDefinitionVote: {
						id: definition.id,
						score: Math.max(0, definition.score - 1),
						myVote: null,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		} else {
			voteCommit({
				variables: {definitionId: definition.id},
				optimisticResponse: {
					voteDefinition: {
						id: definition.id,
						score: definition.score + 1,
						myVote: 1,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		}
	}

	function onEditSubmit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = editBody.trim();
		if (trimmed.length === 0) {
			setEditError("tanım boş olamaz");
			return;
		}
		if (editBody.length > BODY_MAX) {
			setEditError(`tanım en fazla ${BODY_MAX} karakter olabilir`);
			return;
		}
		setEditError(null);
		editCommit({
			variables: {id: definition.id, body: editBody},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setEditError(errors[0]?.message ?? "tanım güncellenemedi");
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

	function onDeleteConfirm() {
		setDeleteError(null);
		deleteCommit({
			variables: {id: definition.id},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setDeleteError(errors[0]?.message ?? "tanım silinemedi");
					return;
				}
				setConfirmDelete(false);
				onMutated();
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setDeleteError(err.message);
			},
		});
	}

	return (
		<article className={cls} data-testid={`definition-card-${definition.id}`}>
			<div className="kp-sozluk-definition__vote">
				<button
					type="button"
					className="kp-sozluk-definition__vote-btn"
					aria-pressed={voted}
					aria-label={voted ? "Oyunu geri al" : "Yukarı oy"}
					data-testid={`definition-vote-${definition.id}`}
					disabled={inFlight}
					onClick={onVoteClick}
				>
					<span className="triangle" />
				</button>
				<span
					className="kp-sozluk-definition__vote-count"
					data-testid={`definition-score-${definition.id}`}
				>
					{definition.score}
				</span>
				<span className="kp-sozluk-definition__rank">#{rank}</span>
			</div>
			<div>
				{editing ? (
					<form className="kp-sozluk-composer" onSubmit={onEditSubmit}>
						<textarea
							className="kp-sozluk-composer__textarea"
							value={editBody}
							onChange={(e) => setEditBody(e.target.value)}
							disabled={editInFlight}
							data-testid={`definition-edit-body-${definition.id}`}
							maxLength={BODY_MAX + 100}
						/>
						{editError ? (
							<p
								className="kp-sozluk-composer__error"
								role="alert"
								data-testid={`definition-edit-error-${definition.id}`}
							>
								{editError}
							</p>
						) : null}
						<footer className="kp-sozluk-composer__foot">
							<span style={{display: "flex", gap: 6}}>
								<Button
									variant="tertiary"
									size="sm"
									type="button"
									disabled={editInFlight}
									onClick={() => {
										setEditing(false);
										setEditBody(definition.body);
										setEditError(null);
									}}
								>
									iptal
								</Button>
								<Button
									variant="primary"
									size="sm"
									type="submit"
									disabled={editInFlight || editBody.trim().length === 0}
									data-testid={`definition-edit-save-${definition.id}`}
								>
									{editInFlight ? "kaydediliyor…" : "kaydet"}
								</Button>
							</span>
						</footer>
					</form>
				) : (
					<Body text={definition.body} />
				)}
				<footer className="kp-sozluk-definition__foot">
					<span className="author">@{definition.author}</span>
					<span className="dot">·</span>
					<span>{formatAgoTR(definition.createdAt)}</span>
					<EditedIndicator
						createdAt={definition.createdAt}
						updatedAt={definition.updatedAt}
					/>
					<span className="actions">
						<button type="button">paylaş</button>
						<button type="button">kalıcı bağlantı</button>
						<button type="button">bildir</button>
						{isAuthor && !editing ? (
							<>
								<button
									type="button"
									data-testid={`definition-edit-${definition.id}`}
									onClick={() => {
										setEditBody(definition.body);
										setEditError(null);
										setEditing(true);
									}}
								>
									düzenle
								</button>
								<button
									type="button"
									data-testid={`definition-delete-${definition.id}`}
									onClick={() => setConfirmDelete(true)}
								>
									sil
								</button>
							</>
						) : null}
					</span>
				</footer>
				{isAuthor ? (
					<Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
						<Dialog.Popup>
							<Dialog.Head
								title="tanımı sil"
								description="bu tanımı silmek istediğine emin misin? geri alınamaz."
							/>
							<Dialog.Body>
								{deleteError ? (
									<p className="kp-sozluk-composer__error" role="alert">
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
									data-testid={`definition-delete-confirm-${definition.id}`}
									onClick={onDeleteConfirm}
								>
									{deleteInFlight ? "siliniyor…" : "sil"}
								</Button>
							</Dialog.Foot>
						</Dialog.Popup>
					</Dialog.Root>
				) : null}
			</div>
		</article>
	);
}

/**
 * Definition body — split paragraphs on blank lines, fenced code as <pre>,
 * inline `code` and **strong** via the shared lib/markdown helpers. A real
 * markdown renderer (react-markdown + sanitizer) replaces this when content
 * gets richer.
 */
function Body({text}: {text: string}) {
	const blocks = splitMarkdownBlocks(text);
	return (
		<div className="kp-sozluk-definition__body">
			{blocks.map((block, i) => {
				if (block.kind === "code") {
					return <pre key={i}>{block.text}</pre>;
				}
				return <p key={i}>{renderMarkdownInline(block.text)}</p>;
			})}
		</div>
	);
}

/**
 * Tiny pill showing the live-updates state (T16). Renders nothing when the
 * WebSocket is connected (the live behavior is invisible by design); shows
 * "canlı güncellemeler duraklatıldı" when disconnected so the user knows
 * they're seeing the last-fetched data without the live overlay.
 *
 * `data-testid` lets E2E tests assert the indicator's visibility across
 * sign-out / disconnect scenarios without scraping arbitrary text.
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

const AddDefinitionMutation = graphql`
  mutation SozlukTermPageAddDefinitionMutation(
    $termSlug: String!
    $termTitle: String
    $body: String!
  ) {
    addDefinition(termSlug: $termSlug, termTitle: $termTitle, body: $body) {
      id
      body
      author
      score
      createdAt
      updatedAt
    }
  }
`;

const BODY_MAX = 10_000;

/**
 * Definition composer wired to the `addDefinition` mutation. Auth-required:
 * signed-out users get redirected to /auth?returnTo=<current>. On success
 * the parent's `onAdded` callback bumps `fetchKey` so the term query
 * re-fetches and the new definition appears in the list (Relay cache
 * invalidation per the task_4 spec).
 */
function Composer({slug, onAdded}: {slug: string; onAdded: () => void}) {
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [commit, isInFlight] =
		useMutation<SozlukTermPageAddDefinitionMutation>(AddDefinitionMutation);

	const trimmed = body.trim();
	const tooLong = body.length > BODY_MAX;
	const disabled = isInFlight || trimmed.length === 0 || tooLong;

	function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${slug}`));
			return;
		}
		if (disabled) return;
		setError(null);
		commit({
			variables: {
				termSlug: slug,
				termTitle: slug.replace(/-/g, " "),
				body,
			},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "tanım eklenemedi");
					return;
				}
				setBody("");
				onAdded();
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setError(err.message);
			},
		});
	}

	return (
		<form className="kp-sozluk-composer" onSubmit={onSubmit}>
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			<textarea
				className="kp-sozluk-composer__textarea"
				placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
				value={body}
				onChange={(e) => setBody(e.target.value)}
				disabled={isInFlight}
				data-testid="sozluk-composer-body"
				maxLength={BODY_MAX + 100}
			/>
			{error ? (
				<p className="kp-sozluk-composer__error" role="alert" data-testid="sozluk-composer-error">
					{error}
				</p>
			) : null}
			{tooLong ? (
				<p className="kp-sozluk-composer__error" role="alert">
					tanım en fazla {BODY_MAX} karakter olabilir ({body.length})
				</p>
			) : null}
			<footer className="kp-sozluk-composer__foot">
				<span className="kp-sozluk-composer__hint">
					markdown · <kbd>⌘</kbd>+<kbd>↵</kbd> gönder
				</span>
				<span style={{display: "flex", gap: 6}}>
					<Button
						variant="tertiary"
						size="sm"
						type="button"
						onClick={() => {
							setBody("");
							setError(null);
						}}
					>
						iptal
					</Button>
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={disabled}
						data-testid="sozluk-composer-submit"
					>
						{isInFlight ? "gönderiliyor…" : "tanımı ekle"}
					</Button>
				</span>
			</footer>
		</form>
	);
}
