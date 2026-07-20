// Vote/edit/delete dispatch through `fate.mutations.definition.*` with optimistic
// updates; the `FateWireCode`s these raise are boundary-class in fate's mutation
// taxonomy, so mutations throw and we catch per-call-site. See
// `.patterns/fate-mutations-client.md`.
import * as React from "react";
import {toEntityId, useFateClient, useLiveView, type ViewRef, view} from "react-fate";
import {useNavigate} from "react-router";
import type {Definition, ReportReceipt} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {bodyEditOptimistic} from "../../fate/optimisticEdit";
import {useDraftSubmit} from "../../fate/useDraftSubmit";
import {codeOf, toIso} from "../../fate/wire";
import {messageForCode, type WireMessageOverrides} from "../../fate/wireMessages";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline, splitMarkdownBlocks} from "../../lib/markdown";
import {authRedirectPath} from "../../lib/returnTo";
import {dropOptimisticDefinitionEdge} from "../../pages/definitionDeleteOptimistic";
import {actorLabel} from "../moderation/actor-identity";
import {useVoteToggle} from "../pano/useVoteToggle";
import {DefinitionReactionBar} from "../reaction/DefinitionReactionBar";
import {ReactionBarSlot} from "../reaction/ReactionBarSlot";
import {Button} from "../ui/Button";
import {CopyLinkButton} from "../ui/CopyLinkButton";
import {Dialog} from "../ui/Dialog";
import {EditedIndicator} from "../ui/EditedIndicator";
import {MetaRow} from "../ui/MetaRow";
import {ReportButton, type ReportOutcome} from "../ui/ReportButton";
import {ReviewBadge} from "../ui/ReviewBadge";
import {useVoteFlash} from "../useVoteFlash";
import {VoteTriangle} from "../VoteTriangle";

export const DefinitionView = view<Definition>()({
	id: true,
	body: true,
	score: true,
	myVote: true,
	createdAt: true,
	updatedAt: true,
	author: true,
	authorId: true,
	authorUsername: true,
	authorDisplayName: true,
	sandboxed: true,
	reactions: {counts: true, myReaction: true},
});

const BODY_MAX = 10_000;

// `report.submit` ack (ADR 0082 — a report has no read view). `created: false` is the
// idempotent re-report no-op, which `ReportButton` surfaces as "zaten bildirildi".
const ReportReceiptView = view<ReportReceipt>()({
	id: true,
	created: true,
});

/** Definition-form copy that overrides the shared {@link WIRE_MESSAGES} base. */
const DEFINITION_OVERRIDES: WireMessageOverrides = {
	BODY_REQUIRED: "tanım boş olamaz",
	BODY_TOO_LONG: `tanım en fazla ${BODY_MAX} karakter olabilir`,
	DEFINITION_NOT_FOUND: "tanım bulunamadı",
};

export interface DefinitionCardProps {
	definition: ViewRef<"Definition">;
	rank: number;
	top: boolean;
	/** Term slug — passed to the auth redirect so a signed-out vote returns here. */
	slug: string;
	/**
	 * Hands the deleted definition's id to the list's delete-side read-back, so a
	 * lost `deleteEdge` push self-heals via a network-only refetch (#1687).
	 */
	onDeleted?: (definitionId: string) => void;
}

export function DefinitionCard(props: DefinitionCardProps) {
	// Live: a definition vote/edit on another client publishes
	// `live.update("Definition", id, …)` with the re-resolved node inline, so the
	// score/body re-render here without a refetch.
	const definition = useLiveView(DefinitionView, props.definition);
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();
	const [editing, setEditing] = React.useState(false);
	const [editBody, setEditBody] = React.useState(definition.body);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const editRedirectPath = () => `/sozluk/${props.slug}`;
	const {
		error: editError,
		setError: setEditError,
		inFlight: editInFlight,
		run: runEdit,
	} = useDraftSubmit({overrides: DEFINITION_OVERRIDES, redirectPath: editRedirectPath});
	const {
		error: deleteError,
		inFlight: deleteInFlight,
		run: runDelete,
	} = useDraftSubmit({overrides: DEFINITION_OVERRIDES, redirectPath: editRedirectPath});

	const voted = definition.myVote === true;
	const {flashing, endFlash} = useVoteFlash(definition.score);
	const cls = props.top ? "kp-sozluk-definition kp-sozluk-definition--top" : "kp-sozluk-definition";
	const isAuthor = !!session.data?.user && session.data.user.id === definition.authorId;

	function redirectIfSignedOut(): boolean {
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${props.slug}`));
			return true;
		}
		return false;
	}

	const onVoteClick = useVoteToggle({
		voted,
		score: definition.score,
		// A signed-out (or UNAUTHORIZED) vote returns to this term's page, not the
		// current location — DefinitionCard renders inside the term route.
		returnTo: () => `/sozluk/${props.slug}`,
		mutations: {
			vote: (optimistic) =>
				fate.mutations.definition.vote({
					input: {id: definition.id},
					optimistic,
					view: DefinitionView,
				}),
			retractVote: (optimistic) =>
				fate.mutations.definition.retractVote({
					input: {id: definition.id},
					optimistic,
					view: DefinitionView,
				}),
		},
	});

	async function onEditSubmit(e: React.SyntheticEvent) {
		e.preventDefault();
		const trimmed = editBody.trim();
		if (trimmed.length === 0) {
			setEditError(messageForCode("BODY_REQUIRED", DEFINITION_OVERRIDES));
			return;
		}
		if (editBody.length > BODY_MAX) {
			setEditError(messageForCode("BODY_TOO_LONG", DEFINITION_OVERRIDES));
			return;
		}
		await runEdit(
			() =>
				fate.mutations.definition.edit({
					input: {id: definition.id, body: editBody},
					optimistic: bodyEditOptimistic(editBody),
					view: DefinitionView,
				}),
			"tanım güncellenemedi",
			() => setEditing(false),
		);
	}

	async function onDeleteConfirm() {
		// `definition.delete` is a **`Term`** mutation (it returns the re-resolved
		// parent so counts update), so fate's `delete: true` can't be used — it
		// would `deleteRecord("Term", definitionId)`, the wrong entity. And the
		// definition lives in the *nested* `Term.definitions` connection, whose
		// membership `insert`/`delete` can't touch. The resolver instead publishes
		// `live.topic("Term.definitions", {id: slug}).deleteEdge`, which the
		// list's `useLiveListView` consumes — the card drops out in place (this
		// client's own view included), no reload.
		await runDelete(
			() => {
				const promise = fate.mutations.definition.delete({input: {id: definition.id}});
				// Optimistic edge-drop (ADR 0125 D1): remove the edge from the nested list
				// state now so the card disappears instantly. The definition id is already
				// canonical, so the server `deleteEdge` frame removes an id already gone —
				// a no-op by canonical id, no reappear. Roll the drop back on any failure
				// (fate has no record write to restore for this Term-returning mutation).
				const rollback = dropOptimisticDefinitionEdge(
					fate.store,
					toEntityId("Term", props.slug),
					toEntityId("Definition", definition.id),
				);
				promise.then(
					(res) => {
						if (res.error) rollback();
					},
					() => rollback(),
				);
				return promise;
			},
			"tanım silinemedi",
			() => {
				setConfirmDelete(false);
				props.onDeleted?.(String(definition.id));
			},
		);
	}

	async function onReport(): Promise<ReportOutcome> {
		if (redirectIfSignedOut()) return "redirected";
		try {
			const {result, error} = await fate.mutations.report.submit({
				input: {targetKind: "definition", targetId: definition.id},
				view: ReportReceiptView,
			});
			if (error) {
				if (codeOf(error) === "UNAUTHORIZED") {
					redirectIfSignedOut();
					return "redirected";
				}
				return "error";
			}
			return result?.created === false ? "already" : "reported";
		} catch (error) {
			if (codeOf(error) === "UNAUTHORIZED") {
				redirectIfSignedOut();
				return "redirected";
			}
			return "error";
		}
	}

	return (
		<article className={cls} data-testid={`definition-card-${definition.id}`}>
			<div className="kp-sozluk-definition__vote">
				{/* Self-vote is blocked (#2216): drop the vote button on one's own definition
				    while the score still renders. The server guard is the invariant, this is
				    the matching affordance. */}
				{isAuthor ? null : (
					<button
						type="button"
						className="kp-sozluk-definition__vote-btn"
						aria-pressed={voted}
						aria-label={voted ? "Oyunu geri al" : "Yukarı oy"}
						data-testid={`definition-vote-${definition.id}`}
						onClick={onVoteClick}
					>
						<VoteTriangle />
					</button>
				)}
				<span
					className={`kp-sozluk-definition__vote-count${flashing ? " kp-vote-flash" : ""}`}
					onAnimationEnd={endFlash}
					data-testid={`definition-score-${definition.id}`}
				>
					{definition.score}
				</span>
				<span className="kp-sozluk-definition__rank">#{props.rank}</span>
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
					<DefinitionBody text={definition.body} />
				)}
				<MetaRow as="footer" className="kp-sozluk-definition__foot">
					{/* Owner-only in-review signal (#2200): `sandboxed` is owner-scoped server-side,
					    re-gated on `isAuthor` so only the author sees their own pending definition's state. */}
					{isAuthor && definition.sandboxed ? <ReviewBadge /> : null}
					{/* Live author identity via `actorLabel` (#2139): CURRENT displayName → @username,
					    falling back to the write-time `author` snapshot for an unstamped/legacy row. */}
					<span className="author">
						{actorLabel(
							definition.authorDisplayName ?? null,
							definition.authorUsername ?? null,
							definition.author,
						)}
					</span>
					<MetaRow.Dot />
					<span>{formatAgoTR(toIso(definition.createdAt))}</span>
					<EditedIndicator
						createdAt={toIso(definition.createdAt)}
						updatedAt={toIso(definition.updatedAt)}
					/>
					<span className="actions">
						<CopyLinkButton
							path={`/sozluk/${props.slug}`}
							testId={`definition-share-${definition.id}`}
						/>
						<ReportButton onReport={onReport} testId={`definition-report-${definition.id}`} />
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
				</MetaRow>
				{!editing ? (
					<ReactionBarSlot>
						<DefinitionReactionBar
							definitionId={definition.id}
							slug={props.slug}
							reactions={definition.reactions}
						/>
					</ReactionBarSlot>
				) : null}
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

function DefinitionBody({text}: {text: string}) {
	const blocks = splitMarkdownBlocks(text);
	return (
		<div className="kp-sozluk-definition__body kp-prose">
			{blocks.map((block, i) => {
				if (block.kind === "code") {
					return <pre key={i}>{block.text}</pre>;
				}
				return <p key={i}>{renderMarkdownInline(block.text)}</p>;
			})}
		</div>
	);
}
