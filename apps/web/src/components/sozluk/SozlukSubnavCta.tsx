import * as React from "react";
import {useNavigate} from "react-router";
import {slugifyTerm} from "../../lib/slugifyTerm";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {Field, Form, Input, Label} from "../ui/Form";

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
	const [open, setOpen] = React.useState(false);
	const navigate = useNavigate();
	function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const term = String(new FormData(e.currentTarget).get("term") ?? "");
		const slug = slugifyTerm(term);
		setOpen(false);
		if (slug) navigate(`/sozluk/${slug}`);
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
						<Field name="term">
							<Label>Terim</Label>
							<Input name="term" required autoFocus placeholder="terim…" />
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
