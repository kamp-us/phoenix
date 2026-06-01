/**
 * Sözlük term page — fate.
 *
 * One batched `useRequest({term: {view: TermView, args: {slug, definitions:{first}}}})`
 * resolves the whole screen (header + first page of definitions) with no
 * waterfall. `term` is the `queries.term` client root; the nested `definitions`
 * connection rides on the `Term` view (`TermView`), delivered inline by the
 * resolver (see `.patterns/fate-connections.md`). Children read their slice:
 * `SozlukTermHeader` via its own `TermHeaderView`, the definitions list via
 * `useLiveListView` (which merges "load more" pages + server-pushed live
 * appends/edge-removals), each row via `useView(DefinitionView, node)`.
 *
 * Mutations (`fate.mutations.definition.*`): add is server-driven live — the
 * `definition.add` resolver publishes `live.connection("Term.definitions",
 * {id: slug}).appendNode`, which the list's `useLiveListView` merges in place
 * (no reload), the author's own view included. The fresh-slug branch (no term
 * yet, so no list to append to) re-reads `term(slug)` once via a `network-only`
 * remount instead. vote/edit/delete live on `DefinitionCard`. Error routing is
 * the call-site catch documented on `DefinitionCard` (fate classifies phoenix
 * codes as boundary, so the mutation throws; the optimistic change rolls back
 * and we surface the code inline).
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
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;
const BODY_MAX = 10_000;

/**
 * The connection selection for a term's definitions — `{items: {node: View}}`,
 * the shape `useLiveListView` reads off `term.definitions`.
 *
 * `live: {append: "visible"}` makes a server-pushed `appendNode` (a new
 * definition from `definition.add`, including this client's own) appear at the
 * end of the list immediately — without it fate's default `"edge"` mode would
 * buffer the append in a hidden `liveAfterIds` set when the first page window is
 * full. See `.patterns/fate-live-views.md`.
 */
const DefinitionConnectionView = {
	items: {node: DefinitionView},
	live: {append: "visible"},
} as const;

/**
 * The term-page view. fate masks by **view identity**: a child's
 * `useView(ChildView, ref)` only works if `ChildView` was **spread**
 * into the view the ref was built from — overlapping field names is not enough.
 * So the page spreads `TermHeaderView` (the header's view) and adds the nested
 * `definitions` connection whose node is `DefinitionView` (the card's view). The
 * children then mask their slice off the same refs.
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
	// Bumped when the fresh-slug composer auto-creates the term: it remounts the
	// content with a fresh request key so the `network-only` read picks up the
	// now-existing term and flips to the connection branch — no full reload.
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
		// `network-only`: a fresh-slug add auto-creates the term, then bumps the
		// remount key; re-reading from the network (not the cached `null`) is what
		// surfaces the new term without a full-page reload.
		{mode: "network-only"},
	);
	const session = useSession();
	const signedIn = !!session.data?.user;

	if (!term) {
		// Signed-out viewers can't auto-create a term — render the shared 404 so
		// the absence is unambiguous. Signed-in viewers get the composer branch so
		// the first definition lands and auto-creates the term (T4's contract).
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
 * Header + composer for the slug-doesn't-exist-yet branch. The first
 * `addDefinition` on a fresh slug auto-creates the term; once it lands the
 * composer calls `onCreated`, which remounts the content so the `network-only`
 * read re-reads `term(slug)` and flips to the connection branch (no full
 * reload). Subsequent definitions on the slug never hit this branch again.
 */
function NewTermComposer({slug, onCreated}: {slug: string; onCreated: () => void}) {
	return (
		<>
			<header className="kp-sozluk-term__head">
				<p className="kp-sozluk-term__crumbs">
					<a href="/sozluk">sözlük</a> / <a href="/sozluk">{slug.charAt(0).toLowerCase()}</a> /{" "}
					{slug.replace(/-/g, " ")}
				</p>
				<h1 className="kp-sozluk-term__title">{slug.replace(/-/g, " ")}</h1>
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
	// Live: `definition.add` (on this client or another) publishes
	// `live.connection("Term.definitions", {id: slug}).appendNode`, which
	// `useLiveListView` merges into the list without a refetch.
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
 * Definition composer wired to `fate.mutations.definition.add`. Auth-required:
 * signed-out users redirect to /auth?returnTo=<current>.
 *
 * **Connection membership.** A fresh definition is a new node in the *nested*
 * `Term.definitions` connection. fate's declarative `insert` only targets
 * **registered root lists** (a list op with no filter args); a nested
 * connection's membership is driven by **server live events**. `definition.add`
 * now publishes `live.connection("Term.definitions", {id: slug}).appendNode`, so
 * the list's `useLiveListView` merges the new row in place — the author's own
 * view included, exactly like `comment.add`. No optimistic temp-node (it would
 * double with the live append) and no reload.
 *
 * `onTermCreated` is only passed on the fresh-slug branch, where there is no
 * list yet to append to: the first add auto-creates the term, then this remounts
 * the content so the `network-only` read flips to the connection branch. Vote /
 * edit / delete are entity-field mutations and stay fully optimistic.
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
			// Fresh-slug branch: the term was just auto-created, so there is no live
			// connection subscribed yet — remount to re-read `term(slug)` and flip to
			// the list branch. The list branch passes no `onTermCreated`: the server's
			// `appendNode` delivers the new row to this client's own `useLiveListView`.
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
