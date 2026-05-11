/**
 * Sözlük term page (task_4, phoenix-relay-idiom).
 *
 * Fully idiomatic Relay shape — `useLazyLoadQuery` at the top spreads
 * `SozlukTermHeaderFragment` + `SozlukTermPageDefinitionsFragment` into
 * the `Term` selection; `usePaginationFragment` reads the definitions
 * connection; each row is a fragment ref handed to `DefinitionCard`
 * (which declares its own `DefinitionCardFragment on Definition`).
 *
 * Live updates flow through `useLiveAgent`: the WebSocket pushes typed
 * `TermState` snapshots, the `applyToStore` callback writes the
 * denormalized aggregates (count, totalScore, lastEdit) into the
 * `Term:<slug>` record via `commitLocalUpdate`. The page tree never
 * unmounts on a live event — `LivePill` connection state is the sole
 * user-visible signal of subscription health (parity with T16).
 *
 * Mutations:
 *  - `addDefinition` — manual `updater` prepends a `DefinitionEdge` into
 *    the `SozlukTermPage_definitions` connection (definitions are
 *    score-DESC; new entries land at the top for visibility), plus
 *    `optimisticResponse` for the immediate flip.
 *  - `deleteDefinition` — payload exposes `deletedDefinitionId @deleteRecord`.
 *    Relay drops the record from the store; the connection edge auto-clears.
 *    No `$connections` variable, no manual updater.
 *  - `editDefinition`, `voteDefinition` / `retractDefinitionVote` — auto
 *    store update on the returned scalars (no updater). Lives on the
 *    `DefinitionCard` component.
 */
import * as React from "react";
import {graphql, useLazyLoadQuery, useMutation, usePaginationFragment} from "react-relay";
import {useNavigate, useParams} from "react-router";
import type {RecordSourceProxy} from "relay-runtime";
import type {SozlukTermPageAddDefinitionMutation} from "../__generated__/SozlukTermPageAddDefinitionMutation.graphql";
import type {SozlukTermPageDefinitionsFragment$key} from "../__generated__/SozlukTermPageDefinitionsFragment.graphql";
import type {SozlukTermPageQuery} from "../__generated__/SozlukTermPageQuery.graphql";
import {useSession} from "../auth/client";
import {DefinitionCard} from "../components/sozluk/DefinitionCard";
import {SozlukTermHeader} from "../components/sozluk/SozlukTermHeader";
import {Button} from "../components/ui/Button";
import {authRedirectPath} from "../lib/returnTo";
import {useLiveAgent} from "../lib/useLiveAgent";
import {useSessionExpiredToast} from "../lib/useSessionExpiredToast";
import {QueryBoundary} from "../relay/QueryBoundary";
import {prependDefinitionToTermConnection} from "../relay/sozlukTermPageUpdater";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;

const TermQuery = graphql`
	query SozlukTermPageQuery($slug: String!, $first: Int) {
		term(slug: $slug) {
			id
			slug
			title
			...SozlukTermHeaderFragment
			...SozlukTermPageDefinitionsFragment @arguments(first: $first)
		}
	}
`;

/**
 * Definitions connection on `Term`. `@refetchable` lets `usePaginationFragment`
 * load subsequent pages; `@connection` lets mutation updaters address the
 * connection by stable key + the parent's DataID.
 *
 * `first: Int` (nullable) per the relay-compiler rule that variables with
 * default values cannot be non-null. Page passes `PAGE_SIZE` as the
 * initial value.
 */
const SozlukTermPageDefinitionsFragmentDef = graphql`
	fragment SozlukTermPageDefinitionsFragment on Term
	@argumentDefinitions(
		first: {type: "Int", defaultValue: 50}
		after: {type: "String"}
	)
	@refetchable(queryName: "SozlukTermPageDefinitionsPaginationQuery") {
		definitions(first: $first, after: $after)
			@connection(key: "SozlukTermPage_definitions") {
			edges {
				node {
					id
					...DefinitionCardFragment
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

const AddDefinitionMutation = graphql`
	mutation SozlukTermPageAddDefinitionMutation(
		$termSlug: String!
		$termTitle: String
		$body: String!
	) {
		addDefinition(termSlug: $termSlug, termTitle: $termTitle, body: $body) {
			id
			body
			score
			myVote
			createdAt
			updatedAt
			author
			authorId
			...DefinitionCardFragment
		}
	}
`;

const BODY_MAX = 10_000;

/**
 * Subset of the `TermState` Agent state shape the page subscribes to over
 * WebSocket — extends `LiveAgentStateShape` so `useLiveAgent`'s typed
 * generic accepts it. Keeping this client-side rather than importing from
 * the worker avoids dragging worker-only modules into the SPA bundle.
 */
interface LiveTermState {
	title: string;
	definitionCount: number;
	totalScore: number;
	lastActivityAt: number;
	lastEventId: string;
}

export function SozlukTermPage() {
	const {slug} = useParams<{slug: string}>();
	const safeSlug = slug ?? "";

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<QueryBoundary
					loading={
						<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>
					}
					error={(err) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							terim yüklenemedi: {err.message}
						</p>
					)}
				>
					<SozlukTermContent slug={safeSlug} />
				</QueryBoundary>
			</div>
		</div>
	);
}

function SozlukTermContent({slug}: {slug: string}) {
	const data = useLazyLoadQuery<SozlukTermPageQuery>(
		TermQuery,
		{slug, first: PAGE_SIZE},
		{fetchPolicy: "store-or-network"},
	);
	const term = data.term;
	const session = useSession();
	const signedIn = !!session.data?.user;

	// Live updates v2 — translates Agent state diffs into Relay store writes.
	// The page tree never unmounts (no `setFetchKey`); LivePill renders the
	// connection state. The applyToStore callback updates the Term node's
	// denormalized aggregates from the typed TermState snapshot.
	//
	// `termRecordId` is captured from the loaded term (when present); we read
	// it lazily inside the callback so the closure doesn't get stale across
	// remounts. When the term doesn't exist yet (signed-in user about to
	// auto-create it), `term?.id` is undefined and the callback no-ops.
	const termRecordId = term?.id ?? null;
	const applyLiveStateToStore = React.useCallback(
		(state: LiveTermState, store: RecordSourceProxy) => {
			if (!termRecordId) return;
			const termRecord = store.get(termRecordId);
			if (!termRecord) return;
			termRecord.setValue(state.definitionCount, "count");
			termRecord.setValue(state.totalScore, "totalScore");
			// `lastActivityAt` arrives as epoch ms; the GraphQL `lastEdit` field
			// is an ISO string. Convert so future fragment reads see a string.
			if (state.lastActivityAt) {
				termRecord.setValue(new Date(state.lastActivityAt).toISOString(), "lastEdit");
			}
		},
		[termRecordId],
	);

	const {connected: liveConnected} = useLiveAgent<LiveTermState>({
		agent: "sozluk-term",
		name: slug,
		applyToStore: applyLiveStateToStore,
		enabled: slug.length > 0,
	});

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
		return <NewTermComposer slug={slug} liveConnected={liveConnected} />;
	}

	return (
		<>
			<SozlukTermHeader term={term} livePill={<LivePill connected={liveConnected} />} />
			<DefinitionsList term={term} slug={slug} />
		</>
	);
}

/**
 * Header + composer for the slug-doesn't-exist-yet branch. After the first
 * `addDefinition` succeeds, the prepend updater can't insert into a
 * connection that doesn't exist (the Term record itself is null in store
 * until the next read). The mutation completes via `onCompleted`; we then
 * trigger a refetch by toggling the local key — narrow scope, only used
 * for the very first definition on a fresh slug.
 */
function NewTermComposer({slug, liveConnected}: {slug: string; liveConnected: boolean}) {
	return (
		<>
			<header className="kp-sozluk-term__head">
				<p className="kp-sozluk-term__crumbs">
					<a href="/sozluk">sözlük</a> /{" "}
					<a href="/sozluk">{slug.charAt(0).toLowerCase()}</a> / {slug.replace(/-/g, " ")}
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
			<NewTermComposerForm slug={slug} />
		</>
	);
}

/**
 * Composer used on the slug-doesn't-exist branch. The first successful add
 * needs to create the `Term` record in the Relay store; we trigger a
 * lightweight refetch by reloading the page query. After the first add the
 * page renders the connection-shaped branch and subsequent adds use the
 * standard prepend updater path.
 */
function NewTermComposerForm({slug}: {slug: string}) {
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
			// No connection updater on this branch — the Term doesn't exist in
			// the store yet, so there's no `SozlukTermPage_definitions`
			// connection to prepend into. After the mutation lands we navigate
			// to the same URL via React Router; the next render reads the
			// Term from network and the page flips to the connection branch.
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "tanım eklenemedi");
					return;
				}
				setBody("");
				// `navigate` to the same URL with `{replace: true}` would NOT
				// remount; we want the page query to refetch so the `Term`
				// record materializes. A full reload is the bluntest possible
				// option but the cleanest — the user just made their first
				// write to a brand-new slug. Subsequent definitions on this
				// slug never hit this branch again.
				window.location.reload();
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

interface DefinitionsListProps {
	term: SozlukTermPageDefinitionsFragment$key & {readonly id: string};
	slug: string;
}

function DefinitionsList(props: DefinitionsListProps) {
	const {data, loadNext, hasNext, isLoadingNext} = usePaginationFragment(
		SozlukTermPageDefinitionsFragmentDef,
		props.term,
	);
	const edges = data.definitions.edges;
	return (
		<>
			{edges.map((edge, i) => {
				if (!edge?.node) return null;
				return (
					<DefinitionCard
						key={edge.node.id}
						definition={edge.node}
						rank={i + 1}
						top={i === 0}
						slug={props.slug}
					/>
				);
			})}
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
			<Composer slug={props.slug} termRecordId={props.term.id} />
		</>
	);
}

/**
 * Definition composer wired to the `addDefinition` mutation. Auth-required:
 * signed-out users get redirected to /auth?returnTo=<current>. On success
 * the manual `updater` prepends a `DefinitionEdge` into the
 * `SozlukTermPage_definitions` connection — the new row appears at the top
 * without a refetch.
 *
 * `optimisticResponse` mirrors the temp-record pattern from `submitPost`
 * (task_2) and `addComment` (task_3) — a `temp-${Date.now()}` id distinguishes
 * the optimistic record in devtools; the updater is idempotent on the
 * optimistic → server-confirm transition.
 */
function Composer({slug, termRecordId}: {slug: string; termRecordId: string}) {
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
		const tempId = `temp-${Date.now()}`;
		commit({
			variables: {
				termSlug: slug,
				termTitle: slug.replace(/-/g, " "),
				body,
			},
			optimisticResponse: {
				addDefinition: {
					id: tempId,
					body,
					score: 0,
					myVote: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					author: session.data?.user?.name ?? "",
					authorId: session.data?.user?.id ?? "",
				},
			},
			updater: (store) => {
				prependDefinitionToTermConnection(store, termRecordId);
			},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "tanım eklenemedi");
					return;
				}
				setBody("");
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

/**
 * Tiny pill showing the live-updates state (T16). Renders the connected
 * indicator in green; the paused indicator in muted gray. `data-testid`
 * lets E2E tests assert the indicator's visibility across sign-out /
 * disconnect scenarios without scraping arbitrary text.
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

