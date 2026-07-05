/**
 * Sözlük term page — fate. One batched `useRequest` resolves header + first page
 * of definitions; `TermView` spreads `TermHeaderView` and adds the nested
 * `definitions` connection (see `.patterns/fate-connections.md`). `definition.add`
 * is server-driven live; the fresh-slug branch (no term yet, so no list to append
 * to) forces a `network-only` re-read of `term(slug)` before remounting — the
 * remount's own render-path read reuses the first mount's fulfilled `data:null`
 * handle WITHOUT refetching (#817), so the re-read must precede it — then arms the
 * deterministic read-back with the mutation's own returned id, so the just-created
 * definition is guaranteed to materialize even if the live `appendNode` push was
 * lost (#730/#714, epic #713).
 */
import * as React from "react";
import {
	toEntityId,
	useFateClient,
	useLiveListView,
	useRequest,
	useView,
	type ViewRef,
	view,
} from "react-fate";
import {useNavigate, useParams} from "react-router";
import type {Term} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {FirstContributionOnramp} from "../components/authorship/FirstContributionOnramp";
import {actorLabel} from "../components/moderation/actor-identity";
import {DefinitionCard, DefinitionView} from "../components/sozluk/DefinitionCard";
import {SozlukTermHeader, TermHeaderView} from "../components/sozluk/SozlukTermHeader";
import {Skeleton} from "../components/ui/atoms";
import {Button} from "../components/ui/Button";
import {DraftRestoreBanner} from "../components/ui/DraftRestoreBanner";
import {Screen} from "../fate/Screen";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import {useConfirmGone, useReadbackRefetch} from "../fate/useReadbackRefetch";
import {LoadMoreButton} from "../fate/wire";
import type {WireMessageOverrides} from "../fate/wireMessages";
import {PHOENIX_OPTIMISTIC_DEFINITION_ADD} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {submitOnCmdEnter} from "../lib/submitShortcut";
import {useDraftAutosave} from "../lib/useDraftAutosave";
import {appendOptimisticDefinitionEdge, buildOptimisticDefinition} from "./definitionAddOptimistic";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;
const BODY_MAX = 10_000;

/** The client-side autosave draft for the definition composer (localStorage, keyed by `/sozluk/<slug>`). */
interface DefinitionDraft {
	body: string;
}

function isDefinitionDraft(value: unknown): value is DefinitionDraft {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as DefinitionDraft).body === "string"
	);
}

const isDefinitionDraftEmpty = (d: DefinitionDraft): boolean => d.body.trim() === "";

/**
 * `live: {append: "visible"}` makes a server-pushed `appendNode` (a new
 * definition, this client's own included) appear immediately, instead of fate's
 * default `"edge"` mode buffering it until a page load. See `.patterns/fate-live-views.md`.
 */
const DefinitionConnectionView = {
	items: {node: DefinitionView},
	live: {append: "visible"},
} as const;

/**
 * The term-page view. fate masks by **view identity**: a child's
 * `useView(ChildView, ref)` works only if `ChildView` was **spread** into the
 * view the ref was built from — overlapping field names is not enough.
 */
const TermView = view<Term>()({
	...TermHeaderView,
	definitions: DefinitionConnectionView,
});

/** Definition-composer copy that overrides the shared {@link WIRE_MESSAGES} base. */
const SOZLUK_OVERRIDES: WireMessageOverrides = {
	BODY_REQUIRED: "tanım boş olamaz",
	BODY_TOO_LONG: `tanım en fazla ${BODY_MAX} karakter olabilir`,
};

/**
 * Layout-preserving Suspense fallback for the term page: a header block (crumbs +
 * title + meta) over a few definition-shaped rows, so the page doesn't jump when the
 * real term resolves into the same {@link SozlukTermHeader} + {@link DefinitionCard}
 * shape. The precedent is `LandingColsSkeleton` — a placeholder mirroring the real
 * content, built from the shared {@link Skeleton} atom.
 */
function SozlukTermSkeleton() {
	return (
		<div role="status" aria-busy="true" aria-label="yükleniyor…" data-testid="sozluk-term-loading">
			<header className="kp-sozluk-term__head">
				<Skeleton width={140} height={12} className="kp-sozluk-term__skeleton-crumbs" />
				<Skeleton width={220} height={20} className="kp-sozluk-term__skeleton-title" />
				<div className="kp-sozluk-term__meta">
					<Skeleton width={56} height={12} />
					<Skeleton width={44} height={12} />
					<Skeleton width={92} height={12} />
				</div>
			</header>
			{[0, 1, 2].map((row) => (
				<div key={row} className="kp-sozluk-definition" aria-hidden="true">
					<div className="kp-sozluk-definition__vote">
						<Skeleton width={26} height={26} />
					</div>
					<div className="kp-sozluk-term__skeleton-lines">
						<Skeleton width="100%" height={12} />
						<Skeleton width="92%" height={12} />
						<Skeleton width="70%" height={12} />
					</div>
				</div>
			))}
		</div>
	);
}

export function SozlukTermPage() {
	const {slug} = useParams<{slug: string}>();
	const safeSlug = slug ?? "";
	// Bumped when the fresh-slug composer auto-creates the term: remounts the content
	// so it reads the now-existing term and flips to the connection branch — no full
	// reload. The composer force-refetches `term(slug)` before bumping this, since the
	// remount's own render read reuses the stale fulfilled-null handle (#817).
	// `createdDefinitionId` carries the mutation's own authoritative result across the
	// remount so the now-list branch can arm its deterministic read-back on it (#730).
	const [{reloadKey, createdDefinitionId}, setRemount] = React.useState<{
		reloadKey: number;
		createdDefinitionId: string | null;
	}>({reloadKey: 0, createdDefinitionId: null});

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={<SozlukTermSkeleton />}
					error={({code}) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							terim yüklenemedi: {code.toLowerCase()}
						</p>
					)}
				>
					<SozlukTermContent
						key={reloadKey}
						slug={safeSlug}
						seedDefinitionId={createdDefinitionId}
						onTermCreated={(definitionId) =>
							setRemount((prev) => ({
								reloadKey: prev.reloadKey + 1,
								createdDefinitionId: definitionId,
							}))
						}
					/>
				</Screen>
			</div>
		</div>
	);
}

function SozlukTermContent({
	slug,
	seedDefinitionId,
	onTermCreated,
}: {
	slug: string;
	seedDefinitionId: string | null;
	onTermCreated: (definitionId: string | null) => void;
}) {
	const {term} = useRequest(
		{term: {view: TermView, args: {slug, definitions: {first: PAGE_SIZE}}}},
		// `network-only`: re-reading from the network (not the cached `null`) is what
		// surfaces a freshly auto-created term after the remount. The remount alone is
		// not enough — the render path reuses a fulfilled-null handle — so the composer
		// force-refetches this request first (#817).
		{mode: "network-only"},
	);
	const session = useSession();
	const signedIn = !!session.data?.user;

	if (!term) {
		// Signed-out viewers can't auto-create a term, so they get the 404;
		// signed-in viewers get the composer that auto-creates it on first define.
		if (!signedIn) {
			return (
				<NotFoundPage
					title="terim bulunamadı"
					message={`"${slug}" diye bir terim henüz yok. giriş yapıp ilk tanımı sen yazabilirsin.`}
				/>
			);
		}
		return <NewTermComposer slug={slug} onCreated={onTermCreated} />;
	}

	return (
		<>
			<SozlukTermHeader term={term} />
			<DefinitionsList term={term} slug={slug} seedDefinitionId={seedDefinitionId} />
		</>
	);
}

/**
 * Header + composer for the slug-doesn't-exist-yet branch. The first definition
 * auto-creates the term, then `onCreated` remounts the content — carrying the new
 * definition's id so the list branch confirms it deterministically (#730).
 */
function NewTermComposer({
	slug,
	onCreated,
}: {
	slug: string;
	onCreated: (definitionId: string | null) => void;
}) {
	return (
		<>
			<header className="kp-sozluk-term__head">
				<p className="kp-sozluk-term__crumbs">
					<a href="/sozluk">sözlük</a> / <a href="/sozluk">{slug.charAt(0).toLowerCase()}</a> /{" "}
					{slug.replace(/-/g, " ")}
				</p>
				<h1 className="kp-sozluk-term__title kp-prose">{slug.replace(/-/g, " ")}</h1>
				<div className="kp-sozluk-term__meta">
					<span>henüz tanım yok</span>
				</div>
			</header>
			<p style={{font: "var(--t-body)", color: "var(--text-muted)"}}>
				"{slug}" terimi henüz yok. ilk tanımı sen yazabilirsin.
			</p>
			<Composer slug={slug} onTermCreated={onCreated} />
		</>
	);
}

interface DefinitionsListProps {
	term: ViewRef<"Term">;
	slug: string;
	/**
	 * The id `definition.add` returned on the fresh-slug remount, or `null` on a
	 * plain load. When set, the list arms its read-back on this id at mount so the
	 * just-created definition materializes even if the live `appendNode` push was
	 * lost (#730/#714).
	 */
	seedDefinitionId: string | null;
}

function DefinitionsList(props: DefinitionsListProps) {
	const fate = useFateClient();
	const term = useView(TermView, props.term);
	const [items, loadNext] = useLiveListView(DefinitionConnectionView, term.definitions);

	const refetchTerm = React.useCallback(
		() =>
			fate.request(
				{term: {view: TermView, args: {slug: props.slug, definitions: {first: PAGE_SIZE}}}},
				{mode: "network-only"},
			),
		[fate, props.slug],
	);

	// Deterministic read-back: if the server's `appendNode` push for the author's own
	// new definition is lost (publish-vs-register race, #714), refetch this page's
	// request `network-only` so the definition lands without a manual refresh.
	const confirmDefinition = useReadbackRefetch({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: refetchTerm,
	});

	// Delete-side read-back (#1687): if the `deleteEdge` push for the author's own
	// delete is lost server-side, the row lingers — refetch `network-only` so it
	// reconciles away, mirroring the add-side self-heal above.
	const confirmDefinitionGone = useConfirmGone({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: refetchTerm,
	});

	// Fresh-slug arrival: this list mounted because a `definition.add` just created the
	// term (the composer already force-refetched the term, so it resolved non-null).
	// Confirm the mutation's own returned id once on mount; the read-back settles
	// instantly if the term re-read already carried the definition, else deterministically
	// refetches it in. Without this the just-created definition silently dropped (#730).
	const {seedDefinitionId} = props;
	React.useEffect(() => {
		if (seedDefinitionId != null) confirmDefinition(seedDefinitionId);
	}, [seedDefinitionId, confirmDefinition]);

	return (
		<>
			{items.map(({node}, i) => (
				<DefinitionCard
					key={node.id}
					definition={node}
					rank={i + 1}
					top={i === 0}
					slug={props.slug}
					onDeleted={confirmDefinitionGone}
				/>
			))}
			{loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
			<Composer slug={props.slug} onConfirm={confirmDefinition} />
		</>
	);
}

/**
 * Definition composer wired to `fate.mutations.definition.add`. Membership in the
 * *nested* `Term.definitions` connection is server-driven (fate's declarative
 * `insert` only targets registered root lists), so an optimistic node is injected
 * by a phoenix client helper rather than `insert` — behind the default-off
 * `phoenix-optimistic-definition-add` flag (ADR 0125, #1679): on, the new definition
 * shows instantly, temp-node reconciled to the server id (dedup by canonical id vs
 * the live append); off, it appears only when the live `appendNode` / read-back
 * lands, exactly as before. `onTermCreated` is passed only on the fresh-slug branch,
 * where there's no list yet to append to (so the optimistic append is skipped
 * there); it force-refetches `term(slug)` then carries the new definition's id across
 * the remount so the list branch arms its read-back on it. On the list branch
 * `onConfirm` hands the new id to the same deterministic read-back — narrowed to the
 * append-loss healer when optimistic is on (the node is already present) — so a lost
 * live `appendNode` self-heals (see {@link useReadbackRefetch}).
 */
function Composer({
	slug,
	onTermCreated,
	onConfirm,
}: {
	slug: string;
	onTermCreated?: (definitionId: string | null) => void;
	onConfirm?: (definitionId: string) => void;
}) {
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();
	// Dark-ship gate (#1679, ADR 0125): off ⇒ no optimistic node, wait for the
	// append/read-back exactly as today.
	const {value: optimisticAdd} = useFlag(PHOENIX_OPTIMISTIC_DEFINITION_ADD, false);
	const [body, setBody] = React.useState("");
	const {
		error,
		setError,
		inFlight: isInFlight,
		run,
	} = useDraftSubmit({overrides: SOZLUK_OVERRIDES, redirectPath: () => `/sozluk/${slug}`});
	const bodyRef = React.useRef<HTMLTextAreaElement>(null);

	const draftValue = React.useMemo<DefinitionDraft>(() => ({body}), [body]);
	const draft = useDraftAutosave({
		route: `/sozluk/${slug}`,
		value: draftValue,
		isEmpty: isDefinitionDraftEmpty,
		isValid: isDefinitionDraft,
	});

	function restoreDraft() {
		if (!draft.offered) return;
		setBody(draft.offered.body);
		setError(null);
		draft.accept();
	}

	const trimmed = body.trim();
	const tooLong = body.length > BODY_MAX;
	const disabled = isInFlight || trimmed.length === 0 || tooLong;

	async function onSubmit(e: React.SyntheticEvent) {
		e.preventDefault();
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${slug}`));
			return;
		}
		if (disabled) return;
		const user = session.data.user;
		// Optimistic nested-append (ADR 0125) only on the existing-term branch: the
		// fresh-slug branch (onTermCreated) has no loaded definitions list to append
		// to and drives its own force-refetch + remount, left untouched.
		const optimistic = buildOptimisticDefinition(optimisticAdd && !onTermCreated, {
			body,
			// Route through the shared actor-label rule (#2126): display name, falling
			// back to a fixed noun, NEVER the email — the old `?? user.email` could
			// surface a user's email in the optimistic author line (a PII leak). The
			// session user carries no typed `username`, so the middle @username tier is
			// unreachable here; the server round-trip replaces this optimistic value.
			author: actorLabel(user.name, null, "kullanıcı"),
			authorId: user.id,
		});
		await run(
			() => {
				const promise = fate.mutations.definition.add({
					input: {termSlug: slug, termTitle: slug.replace(/-/g, " "), body},
					view: DefinitionView,
					...(optimistic ? {optimistic, insert: "none" as const} : {}),
				});
				if (optimistic) {
					// fate wrote the temp record synchronously inside `.add`; append its
					// edge into the nested list now so it renders instantly. The HTTP
					// result triggers fate's resolveOptimisticEntity (temp→server id),
					// which dedups against the live appendNode by canonical id. Roll the
					// edge back on any failure — fate restores its own record write, but
					// not this nested-list insert.
					const rollback = appendOptimisticDefinitionEdge(
						fate.store,
						toEntityId("Term", slug),
						toEntityId("Definition", optimistic.id),
					);
					promise.then(
						(res) => {
							if (res.error) rollback();
						},
						() => rollback(),
					);
				}
				return promise;
			},
			"tanım eklenemedi",
			async (result) => {
				setBody("");
				draft.clear(); // submitted successfully — the autosaved draft is spent
				const createdId = result?.id != null ? String(result.id) : null;
				if (onTermCreated) {
					// Fresh-slug branch: the term now exists, but the first mount's render-path
					// `useRequest({term…}, network-only)` left a fulfilled `data:null` handle for
					// this requestKey, and the remount's render path (`revalidateExisting:false`)
					// reuses it WITHOUT refetching — so a bare remount reads back the cached null
					// and the list branch never mounts (#817). Force a real network re-read first
					// (imperative `request` passes `revalidateExisting:true`, re-executing the
					// handle and repopulating the store), THEN remount so it reads the real term.
					await fate.request(
						{term: {view: TermView, args: {slug, definitions: {first: PAGE_SIZE}}}},
						{mode: "network-only"},
					);
					// Carry the mutation's own returned id across the remount so the list branch
					// arms its deterministic read-back on it (#730).
					onTermCreated(createdId);
				} else if (createdId != null) {
					onConfirm?.(createdId);
				}
			},
		);
	}

	return (
		<form className="kp-sozluk-composer" onSubmit={onSubmit}>
			<FirstContributionOnramp surface="sozluk" onStart={() => bodyRef.current?.focus()} />
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			{draft.offered ? (
				<DraftRestoreBanner onRestore={restoreDraft} onDismiss={draft.dismiss} />
			) : null}
			<textarea
				ref={bodyRef}
				className="kp-sozluk-composer__textarea"
				placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={submitOnCmdEnter}
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
