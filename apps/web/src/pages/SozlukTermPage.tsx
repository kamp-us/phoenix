/**
 * Sözlük term page — fate. One batched `useRequest` resolves header + first page
 * of definitions; `TermView` spreads `TermHeaderView` and adds the nested
 * `definitions` connection (see `.patterns/fate-connections.md`). `definition.add`
 * is server-driven live; the fresh-slug branch (no term yet, so no list to append
 * to) instead re-reads `term(slug)` via a `network-only` remount.
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
	// to the connection branch — no full reload.
	const [reloadKey, setReloadKey] = React.useState(0);

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
						onTermCreated={() => setReloadKey((k) => k + 1)}
					/>
				</Screen>
			</div>
		</div>
	);
}

function SozlukTermContent({slug, onTermCreated}: {slug: string; onTermCreated: () => void}) {
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
			<DefinitionsList term={term} slug={slug} />
		</>
	);
}

/**
 * Header + composer for the slug-doesn't-exist-yet branch. The first definition
 * auto-creates the term, then `onCreated` remounts the content so the
 * `network-only` read flips to the connection branch.
 */
function NewTermComposer({slug, onCreated}: {slug: string; onCreated: () => void}) {
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
}

function DefinitionsList(props: DefinitionsListProps) {
	const term = useView(TermView, props.term);
	const [items, loadNext] = useLiveListView(DefinitionConnectionView, term.definitions);

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
			<Composer slug={props.slug} />
		</>
	);
}

/**
 * Definition composer wired to `fate.mutations.definition.add`. Membership in the
 * *nested* `Term.definitions` connection is server-driven (fate's declarative
 * `insert` only targets registered root lists), so there is no optimistic
 * temp-node — it would double with the live append. `onTermCreated` is passed
 * only on the fresh-slug branch, where there's no list yet to append to.
 */
function Composer({slug, onTermCreated}: {slug: string; onTermCreated?: () => void}) {
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [isInFlight, setInFlight] = React.useState(false);

	const trimmed = body.trim();
	const tooLong = body.length > BODY_MAX;
	const disabled = isInFlight || trimmed.length === 0 || tooLong;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${slug}`));
			return;
		}
		if (disabled) return;
		setError(null);
		setInFlight(true);
		try {
			const {error: callError} = await fate.mutations.definition.add({
				input: {termSlug: slug, termTitle: slug.replace(/-/g, " "), body},
				view: DefinitionView,
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			setBody("");
			// Fresh-slug branch only: remount to re-read `term(slug)` and flip to the
			// list branch. On the list branch the server's `appendNode` delivers the row.
			onTermCreated?.();
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
