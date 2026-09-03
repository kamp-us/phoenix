/**
 * Sözlük term page. One batched `useRequest` resolves the header + first page of
 * definitions (see `.patterns/fate-connections.md`). The page has two branches: an
 * existing term, and a slug with no term yet, where the first definition creates it.
 */

import {Alert, Button, DraftRestoreBanner, Kbd, Skeleton, Textarea} from "@kampus/design";
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
import {Link, useNavigate, useParams} from "react-router";
import type {Term} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {FirstContributionOnramp} from "../components/authorship/FirstContributionOnramp";
import {actorLabel} from "../components/moderation/actor-identity";
import {DefinitionCard, DefinitionView} from "../components/sozluk/DefinitionCard";
import {SozlukTermHeader, TermHeaderView} from "../components/sozluk/SozlukTermHeader";
import {Screen} from "../fate/Screen";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import {useConfirmGone, useReadbackRefetch} from "../fate/useReadbackRefetch";
import {LoadMoreButton} from "../fate/wire";
import type {WireMessageOverrides} from "../fate/wireMessages";
import {authRedirectPath} from "../lib/returnTo";
import {submitOnCmdEnter} from "../lib/submitShortcut";
import {useDraftAutosave} from "../lib/useDraftAutosave";
import {appendOptimisticDefinitionEdge, buildOptimisticDefinition} from "./definitionAddOptimistic";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;
const BODY_MAX = 10_000;

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

// `append: "visible"` overrides fate's default `"edge"` buffering — see `.patterns/fate-live-views.md`.
const DefinitionConnectionView = {
	items: {node: DefinitionView},
	live: {append: "visible"},
} as const;

// A child's `useView(ChildView, ref)` works only if `ChildView` was SPREAD in here —
// fate masks by view identity, so matching field names is not enough.
const TermView = view<Term>()({
	...TermHeaderView,
	definitions: DefinitionConnectionView,
});

const SOZLUK_OVERRIDES: WireMessageOverrides = {
	BODY_REQUIRED: "tanım boş olamaz",
	BODY_TOO_LONG: `tanım en fazla ${BODY_MAX} karakter olabilir`,
};

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
	// Bumping `reloadKey` remounts the content onto the now-existing term. The composer
	// must force-refetch `term(slug)` BEFORE bumping it, or the remount's render read
	// reuses the stale fulfilled-null handle (#817).
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
	// Set only on the fresh-slug remount: the id the list arms its read-back on (#730).
	seedDefinitionId: string | null;
}

export function DefinitionsList(props: DefinitionsListProps) {
	const fate = useFateClient();
	const session = useSession();
	const signedIn = !!session.data?.user;
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

	// Delete-side twin of the read-back above: a lost `deleteEdge` push would otherwise
	// leave the deleted row rendered forever (#1687).
	const confirmDefinitionGone = useConfirmGone({
		presentIds: items.map(({node}) => String(node.id)),
		refetch: refetchTerm,
	});

	// On the fresh-slug remount, confirm the mutation's own returned id once; without it
	// the just-created definition silently dropped (#730).
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
			{signedIn ? (
				<Composer slug={props.slug} onConfirm={confirmDefinition} />
			) : (
				<DefinitionSignInPrompt slug={props.slug} />
			)}
		</>
	);
}

function DefinitionSignInPrompt({slug}: {slug: string}) {
	return (
		<div className="kp-sozluk-composer" data-testid="sozluk-composer-signin">
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			<p style={{font: "var(--t-body)", color: "var(--text-muted)"}}>
				tanım eklemek için <Link to={authRedirectPath(`/sozluk/${slug}`)}>giriş yap</Link>.
			</p>
		</div>
	);
}

// fate's declarative `insert` only targets registered ROOT lists, and `Term.definitions`
// is nested, so the optimistic node goes in through a client helper instead (ADR 0125).
// Exactly one of `onTermCreated` (fresh slug) / `onConfirm` (existing term) is passed.
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
	const {
		error,
		setError,
		inFlight: isInFlight,
		run,
	} = useDraftSubmit({overrides: SOZLUK_OVERRIDES, redirectPath: () => `/sozluk/${slug}`});
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
		// Optimistic append only on the existing-term branch — the fresh-slug branch has no
		// loaded list to append to.
		const optimistic = buildOptimisticDefinition(!onTermCreated, {
			body,
			// Never fall back to `user.email` here — it would render in the author line (#2126).
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
					// fate wrote the temp record synchronously inside `.add`, so the edge can go
					// in now. Roll it back on failure by hand: fate restores its own record
					// write but not this nested-list insert.
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
				draft.clear();
				const createdId = result?.id != null ? String(result.id) : null;
				if (onTermCreated) {
					// The first mount left a fulfilled `data:null` handle for this requestKey, and
					// a remount's render path reuses it WITHOUT refetching — so the re-read has to
					// be imperative and has to happen BEFORE the remount, or the list branch never
					// mounts (#817).
					await fate.request(
						{term: {view: TermView, args: {slug, definitions: {first: PAGE_SIZE}}}},
						{mode: "network-only"},
					);
					onTermCreated(createdId);
				} else if (createdId != null) {
					onConfirm?.(createdId);
				}
			},
		);
	}

	return (
		<form className="kp-sozluk-composer" onSubmit={onSubmit}>
			<FirstContributionOnramp surface="sozluk" />
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			{draft.offered ? (
				<DraftRestoreBanner onRestore={restoreDraft} onDismiss={draft.dismiss} />
			) : null}
			<Textarea
				className="kp-sozluk-composer__textarea"
				aria-label="tanım"
				placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={submitOnCmdEnter}
				disabled={isInFlight}
				data-testid="sozluk-composer-body"
				maxLength={BODY_MAX + 100}
				resize="vertical"
			/>
			{error ? (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-sozluk-composer__error"
					data-testid="sozluk-composer-error"
				>
					{error}
				</Alert>
			) : null}
			{tooLong ? (
				<Alert variant="danger" className="kp-alert--inline kp-sozluk-composer__error">
					tanım en fazla {BODY_MAX} karakter olabilir ({body.length})
				</Alert>
			) : null}
			<footer className="kp-sozluk-composer__foot">
				<span className="kp-sozluk-composer__hint">
					markdown · <Kbd>⌘</Kbd>+<Kbd>↵</Kbd> gönder
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
