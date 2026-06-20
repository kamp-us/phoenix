/**
 * Sözlük term page — fate. One batched `useRequest` resolves header + first page
 * of definitions; `TermView` spreads `TermHeaderView` and adds the nested
 * `definitions` connection (see `.patterns/fate-connections.md`). `definition.add`
 * is server-driven live; the fresh-slug branch (no term yet, so no list to append
 * to) re-reads `term(slug)` via a `network-only` remount and then arms the
 * deterministic read-back with the mutation's own returned id, so the just-created
 * definition is guaranteed to materialize even if the remount re-read raced the
 * write or the live `appendNode` push was lost (#730, epic #713 Family B).
 */
import * as React from "react";
import {useFateClient, useLiveListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {useNavigate, useParams} from "react-router";
import type {Term} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {DefinitionCard, DefinitionView} from "../components/sozluk/DefinitionCard";
import {SozlukTermHeader, TermHeaderView} from "../components/sozluk/SozlukTermHeader";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import {useLiveKeepAlive} from "../fate/useLiveKeepAlive";
import {useReadbackRefetch} from "../fate/useReadbackRefetch";
import {codeOf, LoadMoreButton} from "../fate/wire";
import type {MutationErrorCode} from "../lib/mutationErrorCodes";
import {authRedirectPath} from "../lib/returnTo";
import {submitOnCmdEnter} from "../lib/submitShortcut";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;
const BODY_MAX = 10_000;

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

const messageForCode = (code: MutationErrorCode, fallback: string): string => {
	switch (code) {
		case "BODY_REQUIRED":
			return "tanım boş olamaz";
		case "BODY_TOO_LONG":
			return `tanım en fazla ${BODY_MAX} karakter olabilir`;
		default:
			return fallback;
	}
};

export function SozlukTermPage() {
	const {slug} = useParams<{slug: string}>();
	const safeSlug = slug ?? "";
	// Bumped when the fresh-slug composer auto-creates the term: remounts the
	// content so the `network-only` read picks up the now-existing term and flips
	// to the connection branch — no full reload. `createdDefinitionId` carries the
	// mutation's own authoritative result across the remount so the now-list branch
	// can arm its deterministic read-back on it (the remount re-read can race the
	// write; the seeded id makes the just-created definition appear regardless).
	const [{reloadKey, createdDefinitionId}, setRemount] = React.useState<{
		reloadKey: number;
		createdDefinitionId: string | null;
	}>({reloadKey: 0, createdDefinitionId: null});

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<Screen
					fallback={<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>}
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
		// surfaces a freshly auto-created term after the remount.
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
	 * just-created definition materializes even if the remount's `network-only`
	 * re-read raced the write or the live push was lost (#730).
	 */
	seedDefinitionId: string | null;
}

function DefinitionsList(props: DefinitionsListProps) {
	const fate = useFateClient();
	const term = useView(TermView, props.term);
	// Pin the SSE connection on the stable parent `Term` for the list's mount
	// lifetime, so the definition list's per-mutation re-subscribe churn never
	// drops the refcount to 0 and drops the live `appendNode` (#708; #711 is the
	// durable transport fix). See `apps/web/src/fate/useLiveKeepAlive.ts`.
	useLiveKeepAlive(TermView, props.term);
	const [items, loadNext] = useLiveListView(DefinitionConnectionView, term.definitions);

	// Deterministic read-back: if the server's `appendNode` push for the author's own
	// new definition is lost (publish-vs-register race, #714), refetch this page's
	// request `network-only` so the definition lands without a manual refresh.
	const confirmDefinition = useReadbackRefetch({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: () =>
			fate.request(
				{term: {view: TermView, args: {slug: props.slug, definitions: {first: PAGE_SIZE}}}},
				{mode: "network-only"},
			),
	});

	// Fresh-slug arrival: this list mounted because a `definition.add` just created
	// the term. The remount's `network-only` re-read is not authoritative — it can
	// race the write — so confirm the mutation's own returned id once on mount; the
	// read-back settles instantly if the re-read already carried it, else deterministically
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
 * `insert` only targets registered root lists), so there is no optimistic
 * temp-node — it would double with the live append. `onTermCreated` is passed
 * only on the fresh-slug branch, where there's no list yet to append to; it carries
 * the new definition's id across the remount so the list branch arms its read-back
 * on it. On the list branch `onConfirm` hands the new id to the same deterministic
 * read-back so a lost live `appendNode` self-heals (see {@link useReadbackRefetch}).
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
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [isInFlight, setInFlight] = React.useState(false);

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
		setError(null);
		setInFlight(true);
		try {
			const {result, error: callError} = await fate.mutations.definition.add({
				input: {termSlug: slug, termTitle: slug.replace(/-/g, " "), body},
				view: DefinitionView,
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			setBody("");
			const createdId = result?.id != null ? String(result.id) : null;
			// Fresh-slug branch only: remount to re-read `term(slug)` and flip to the
			// list branch, carrying the mutation's own returned id so that branch confirms
			// it deterministically (the remount re-read can race the write — #730).
			onTermCreated?.(createdId);
			if (createdId != null) onConfirm?.(createdId);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(`/sozluk/${slug}`));
				return;
			}
			setError(messageForCode(code, "tanım eklenemedi"));
		} finally {
			setInFlight(false);
		}
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
