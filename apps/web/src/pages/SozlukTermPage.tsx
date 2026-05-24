/**
 * Sözlük term page — fate.
 *
 * One batched `useRequest({term: {view: TermView, args: {slug, definitions:{first}}}})`
 * resolves the whole screen (header + first page of definitions) with no
 * waterfall. `term` is the `queries.term` client root; the nested `definitions`
 * connection rides on the `Term` view (`TermView`), delivered inline by the
 * resolver (see `.patterns/fate-connections.md`). Children read their slice:
 * `SozlukTermHeader` via its own `TermHeaderView`, the definitions list via
 * `useListView` (which merges "load more" pages), each row via
 * `useView(DefinitionView, node)`.
 *
 * Mutations (`fate.mutations.definition.*`): add reloads after success to show
 * the new row (nested-connection membership; `definition.add` publishes no live
 * append — see the `Composer` note); vote/edit/delete live on `DefinitionCard`.
 * Error routing is the call-site catch documented on `DefinitionCard` (fate
 * classifies phoenix codes as boundary, so the mutation throws; the optimistic
 * change rolls back and we surface the code inline).
 */
import * as React from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {useNavigate, useParams} from "react-router";
import type {Term} from "../../worker/fate/views";
import {useSession} from "../auth/client";
import {DefinitionCard, DefinitionView} from "../components/sozluk/DefinitionCard";
import {SozlukTermHeader, TermHeaderView} from "../components/sozluk/SozlukTermHeader";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import {decodeMutationErrorCode, type MutationErrorCode} from "../lib/mutationErrorCodes";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "./SozlukTermPage.css";

const PAGE_SIZE = 50;
const BODY_MAX = 10_000;

/**
 * The connection selection for a term's definitions — `{items: {node: View}}`,
 * the shape `useListView` reads off `term.definitions`.
 */
const DefinitionConnectionView = {items: {node: DefinitionView}} as const;

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

/** Read the `.code` off a thrown / returned fate error. */
const codeOf = (error: unknown): MutationErrorCode => {
	const code =
		error && typeof error === "object" && "code" in error ? (error as {code: unknown}).code : null;
	return decodeMutationErrorCode(code) ?? "INTERNAL_SERVER_ERROR";
};

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
					<SozlukTermContent slug={safeSlug} />
				</Screen>
			</div>
		</div>
	);
}

function SozlukTermContent({slug}: {slug: string}) {
	const {term} = useRequest({
		term: {view: TermView, args: {slug, definitions: {first: PAGE_SIZE}}},
	});
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
		return <NewTermComposer slug={slug} />;
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
 * `addDefinition` on a fresh slug auto-creates the term; once it lands we reload
 * so the page re-reads through `term(slug)` and flips to the connection branch.
 * Subsequent definitions on the slug never hit this branch again.
 */
function NewTermComposer({slug}: {slug: string}) {
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
			<Composer slug={slug} />
		</>
	);
}

interface DefinitionsListProps {
	term: ViewRef<"Term">;
	slug: string;
}

function DefinitionsList(props: DefinitionsListProps) {
	const term = useView(TermView, props.term);
	const [items, loadNext] = useListView(DefinitionConnectionView, term.definitions);

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

function LoadMoreButton({loadNext}: {loadNext: () => Promise<void>}) {
	const [loading, setLoading] = React.useState(false);
	return (
		<Button
			variant="tertiary"
			size="sm"
			type="button"
			disabled={loading}
			onClick={async () => {
				setLoading(true);
				try {
					await loadNext();
				} finally {
					setLoading(false);
				}
			}}
		>
			{loading ? "yükleniyor…" : "daha fazla"}
		</Button>
	);
}

/**
 * Definition composer wired to `fate.mutations.definition.add`. Auth-required:
 * signed-out users redirect to /auth?returnTo=<current>.
 *
 * **Connection membership.** A fresh definition is a new node in the *nested*
 * `Term.definitions` connection. fate's declarative `insert` only targets
 * **registered root lists** (a list op with no filter args); a nested
 * connection's membership is driven by **server live events**
 * (`live.connection(...).appendNode`), and `definition.add` publishes no such
 * append. So `insert`/an optimistic temp-node can't join this list. We therefore
 * **reload after a successful add** so the page re-reads `term(slug)` and the new
 * row appears (the same reload the fresh-slug branch needs). Vote / edit / delete
 * are entity-field mutations and stay fully optimistic.
 */
function Composer({slug}: {slug: string}) {
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
		const user = session.data.user;
		const now = new Date();
		try {
			const {error: callError} = await fate.mutations.definition.add({
				input: {termSlug: slug, termTitle: slug.replace(/-/g, " "), body},
				view: DefinitionView,
				// Temp id; fate reconciles it to the server id when the result lands.
				// The new node is normalized into the cache; it only *joins the
				// nested list* once we reload (no declarative nested-insert — see the
				// note above). The forced-error path rolls this back.
				optimistic: {
					id: `optimistic:${Date.now()}`,
					body,
					score: 0,
					myVote: null,
					createdAt: now,
					updatedAt: now,
					author: user.name ?? user.email,
					authorId: user.id,
				},
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			setBody("");
			// `definition.add` publishes no live append, so reload to re-read
			// `term(slug)` and surface the new row.
			window.location.reload();
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
