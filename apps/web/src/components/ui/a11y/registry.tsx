/**
 * The primitive classification registry for the property-based a11y loop (#2175,
 * ADR 0162 pillar 4). Each runtime export of `../index.ts` is classified once as
 * `interactive`, `presentational`, or `deferred`, and the interactive/presentational
 * entries carry a `fast-check` arbitrary that generates a randomized VALID render
 * (a representative prop combination) for the harness to assert invariants over.
 *
 * Auto-coverage: the suite enumerates the barrel's runtime exports and requires
 * every one to appear here (see `a11y-pbt.test.tsx`'s coverage test) — a newly
 * added primitive that no one classified fails the gate, so the covered set can
 * never silently go stale. `deferred` is a conscious, reasoned parking spot (a
 * compound base-ui/portal primitive, or a control needing composition context to
 * have an accessible name), not an escape hatch — each carries its promotion reason.
 */

import fc from "fast-check";
import type {ReactElement} from "react";
import {Avatar} from "../Avatar";
import {Code, Kbd, Mark, Skeleton, Tag} from "../atoms";
import {Button} from "../Button";
import {Card, Surface} from "../Card";
import {CountToggle} from "../CountToggle";
import {MetaRow} from "../MetaRow";

/** An interactive control: name/focus invariants apply to its `selector` element. */
export interface InteractiveSpec {
	readonly kind: "interactive";
	/** CSS selector for the control inside the render root (button/a/input). */
	readonly selector: string;
	readonly arb: fc.Arbitrary<ReactElement>;
}

/** A decorative/structural primitive: only the structural axe invariants apply. */
export interface PresentationalSpec {
	readonly kind: "presentational";
	readonly arb: fc.Arbitrary<ReactElement>;
}

/** A primitive not (yet) in the bare-prop harness, with the reason it is parked. */
export interface DeferredSpec {
	readonly kind: "deferred";
	readonly reason: string;
}

export type PrimitiveSpec = InteractiveSpec | PresentationalSpec | DeferredSpec;

/** A short, always-present, human-readable label so a control has an accessible name. */
const label = fc.constantFrom("Beğen", "Yanıtla", "Paylaş", "Gönder", "Kaydet", "Aç");
/** Prose children for a presentational container. */
const text = fc.constantFrom("kamp.us", "sözlük", "panolar", "bir başlık", "42");

const buttonArb: fc.Arbitrary<ReactElement> = fc
	.record({
		variant: fc.constantFrom(...(["primary", "secondary", "tertiary", "danger"] as const)),
		size: fc.constantFrom(...(["sm", "md", "lg"] as const)),
		block: fc.boolean(),
		pressed: fc.boolean(),
		disabled: fc.boolean(),
		loading: fc.boolean(),
		withIcon: fc.boolean(),
		children: label,
	})
	.map(({withIcon, children, ...props}) => (
		<Button {...props} icon={withIcon ? <span>+</span> : undefined}>
			{children}
		</Button>
	));

const countToggleArb: fc.Arbitrary<ReactElement> = fc
	.record({
		pressed: fc.boolean(),
		count: fc.option(fc.integer({min: 0, max: 9999}), {nil: undefined}),
		showZero: fc.boolean(),
		disabled: fc.boolean(),
		withIcon: fc.boolean(),
		// The control is always named — via a text child or an aria-label, since
		// the icon is decorative (CountToggle's own contract).
		name: label,
		useAriaLabel: fc.boolean(),
	})
	.map(({withIcon, name, useAriaLabel, ...props}) => (
		<CountToggle
			{...props}
			icon={withIcon ? <span aria-hidden="true">♥</span> : undefined}
			aria-label={useAriaLabel ? name : undefined}
		>
			{useAriaLabel ? undefined : name}
		</CountToggle>
	));

const surfaceArb: fc.Arbitrary<ReactElement> = fc
	.record({
		tone: fc.constantFrom(...(["default", "raised", "sunken"] as const)),
		elevation: fc.constantFrom(...(["flat", "raised", "dropdown", "overlay"] as const)),
		radius: fc.constantFrom(...(["none", "sm", "md", "lg"] as const)),
		padding: fc.constantFrom(...(["none", "sm", "md", "lg"] as const)),
		border: fc.boolean(),
		children: text,
	})
	.map(({children, ...props}) => <Surface {...props}>{children}</Surface>);

const cardArb: fc.Arbitrary<ReactElement> = fc
	.record({
		interactive: fc.boolean(),
		radius: fc.constantFrom(...(["sm", "md", "lg"] as const)),
		children: text,
	})
	.map(({children, ...props}) => <Card {...props}>{children}</Card>);

const metaRowArb: fc.Arbitrary<ReactElement> = fc
	.record({author: label, body: text})
	.map(({author, body}) => (
		<MetaRow>
			<span className="author">{author}</span>
			<MetaRow.Dot />
			<span>{body}</span>
		</MetaRow>
	));

const avatarArb: fc.Arbitrary<ReactElement> = fc
	.record({
		name: fc.constantFrom("Umut Sirin", "Can Sirin", "ada"),
		withSrc: fc.boolean(),
		size: fc.constantFrom(...(["sm", "md", "lg", "xl"] as const)),
	})
	.map(({withSrc, name, size}) => (
		<Avatar name={name} size={size} src={withSrc ? "https://example.com/a.png" : undefined} />
	));

const tagArb: fc.Arbitrary<ReactElement> = fc
	.record({
		kind: fc.constantFrom(...(["discuss", "ask", "show", "rant", "meta", "news"] as const)),
		withHref: fc.boolean(),
		children: text,
	})
	.map(({withHref, children, kind}) => (
		<Tag kind={kind} href={withHref ? "/pano" : undefined}>
			{children}
		</Tag>
	));

const inlineAtomArb = (
	Comp: (p: {children: React.ReactNode}) => ReactElement,
): fc.Arbitrary<ReactElement> => text.map((children) => <Comp>{children}</Comp>);

const skeletonArb: fc.Arbitrary<ReactElement> = fc
	.record({width: fc.integer({min: 8, max: 320}), height: fc.integer({min: 8, max: 64})})
	.map((props) => <Skeleton {...props} />);

/** Reason shared by the base-ui compound primitives parked out of the bare-prop harness. */
const COMPOUND_REASON =
	"compound base-ui primitive — needs its Root/Trigger/Panel (or portal/provider) composition to render a representative interactive surface; covered by its composed-usage tests, a promotion candidate for a composed a11y fixture.";

/**
 * The classification of EVERY runtime export of `../index.ts`. The coverage test
 * asserts this key set equals the barrel's runtime export set, so adding or
 * removing a primitive without updating this map fails the gate.
 */
export const REGISTRY: Readonly<Record<string, PrimitiveSpec>> = {
	// Interactive controls — the full name/focus/ARIA invariant set applies.
	Button: {kind: "interactive", selector: "button", arb: buttonArb},
	CountToggle: {kind: "interactive", selector: "button", arb: countToggleArb},

	// Presentational primitives — structural ARIA invariants only.
	Surface: {kind: "presentational", arb: surfaceArb},
	Card: {kind: "presentational", arb: cardArb},
	MetaRow: {kind: "presentational", arb: metaRowArb},
	Avatar: {kind: "presentational", arb: avatarArb},
	Tag: {kind: "presentational", arb: tagArb},
	Code: {kind: "presentational", arb: inlineAtomArb(Code)},
	Kbd: {kind: "presentational", arb: inlineAtomArb(Kbd)},
	Mark: {kind: "presentational", arb: inlineAtomArb(Mark)},
	Skeleton: {kind: "presentational", arb: skeletonArb},

	// Deferred — compound / portal / provider-bound base-ui primitives.
	Collapsible: {kind: "deferred", reason: COMPOUND_REASON},
	Dialog: {kind: "deferred", reason: COMPOUND_REASON},
	Menu: {kind: "deferred", reason: COMPOUND_REASON},
	Tabs: {kind: "deferred", reason: COMPOUND_REASON},
	ToggleGroup: {kind: "deferred", reason: COMPOUND_REASON},
	Switch: {kind: "deferred", reason: COMPOUND_REASON},
	Tooltip: {kind: "deferred", reason: COMPOUND_REASON},
	TooltipProvider: {kind: "deferred", reason: COMPOUND_REASON},

	// Deferred — form controls whose accessible name comes from a composed Field/Label.
	Field: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	FieldError: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	Form: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	Hint: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	Input: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	Label: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},
	Textarea: {
		kind: "deferred",
		reason: "form control — accessible name comes from a composed Field/Label wrapper.",
	},

	// Deferred — controls with side effects / data props needing a composed fixture.
	CopyLinkButton: {
		kind: "deferred",
		reason: "control with a clipboard side effect + a URL prop — needs a composed fixture.",
	},
	ReportButton: {
		kind: "deferred",
		reason: "control driving a report mutation + callback props — needs a composed fixture.",
	},
	DraftRestoreBanner: {
		kind: "deferred",
		reason: "needs draft data + restore/discard callback props — a composed fixture.",
	},
	EmptyState: {
		kind: "deferred",
		reason: "needs content/action props to render a representative surface — a composed fixture.",
	},
} as const;
