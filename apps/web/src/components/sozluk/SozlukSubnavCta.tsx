import type * as React from "react";
import {useNavigate} from "react-router";
import {slugifyTerm} from "../../lib/slugifyTerm";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {Field, FieldError, Form, Input, Label} from "../ui/Form";
import {useSozlukCreateDialog} from "./SozlukCreateDialogState";

/**
 * sözlük's contextual create CTA — the `+ yeni tanım` promoted verb in its Subnav
 * `primaryAction` zone (design-system-manifest: a product-scoped create CTA is a
 * contextual primary action; placement law #2587). It replaces the old go-to-or-create
 * box, whose "go to a term" search half folded into the global ⌘K `ara` (#2995, the #2412
 * single-search contract) leaving only the create half here as a plain action, never a
 * second search surface.
 *
 * A dialog collects the term name because the composer is slug-addressed (`/sozluk/:slug`):
 * the submit slugifies the typed term (`slugifyTerm`) and routes to the fresh-slug composer
 * branch — the exact target the old box reached, create dead-end handled there (#97).
 */
export function SozlukSubnavCta() {
	// `open` is hoisted above the FateProvider/needsBootstrap unmounting boundary (#3840) —
	// see `SozlukCreateDialogState`. A component-local `useState` here is the exact fragility
	// #3600 pinned: an ancestor unmount would silently reset it, vanishing the dialog.
	const {open, setOpen} = useSozlukCreateDialog();
	const navigate = useNavigate();
	function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		// `validateTerm` (below) blocks the base-ui submit while the term is unslugifiable,
		// so a term that reaches here always yields a slug; the guard is the last-resort no-op
		// that never navigates to an empty slug (#3746 dismiss, #3789 no-op).
		const slug = slugifyTerm(String(new FormData(e.currentTarget).get("term") ?? ""));
		if (!slug) return;
		setOpen(false);
		navigate(`/sozluk/${slug}`);
	}
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger
				render={
					<Button variant="primary" icon={<PlusGlyph />}>
						yeni tanım
					</Button>
				}
			/>
			<Dialog.Popup>
				<Dialog.Head title="Yeni tanım" description="oluşturmak istediğin terimi yaz." />
				<Dialog.Body>
					<Form onSubmit={onSubmit}>
						<Field name="term" validate={validateTerm}>
							<Label>Terim</Label>
							<Input name="term" required autoFocus placeholder="terim…" />
							<FieldError match="customError">{UNSLUGIFIABLE_TERM_MESSAGE}</FieldError>
						</Field>
						<Dialog.Foot>
							<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
							<Button variant="primary" type="submit">
								oluştur
							</Button>
						</Dialog.Foot>
					</Form>
				</Dialog.Body>
			</Dialog.Popup>
		</Dialog.Root>
	);
}

// A punctuation-only term (e.g. "!!!") is a non-empty value `required` accepts but that
// `slugifyTerm` reduces to "" — the composer is slug-addressed, so it has nowhere to go.
// Surfacing it as a field error (base-ui blocks the submit + flags `customError`) replaces the
// silent no-op the bare `if (!slug) return` guard left behind (#3789). Empty is left to
// `required`; only the non-empty-but-unslugifiable term errors here. Turkish copy, per the
// user-facing sözlük surface (.glossary/LANGUAGE.md).
const UNSLUGIFIABLE_TERM_MESSAGE = "Terim en az bir harf ya da rakam içermeli.";

function validateTerm(value: unknown): string | null {
	const term = String(value ?? "");
	if (!term.trim()) return null;
	return slugifyTerm(term) ? null : UNSLUGIFIABLE_TERM_MESSAGE;
}

function PlusGlyph() {
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			aria-hidden="true"
		>
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}
