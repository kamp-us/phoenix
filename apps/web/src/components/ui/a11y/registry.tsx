/**
 * The primitive classification registry for the property-based a11y loop — see
 * `.patterns/property-based-a11y.md`. Arbitraries must generate only VALID props,
 * and `deferred` is a reason-carrying parking spot, not an escape hatch.
 */

import fc from "fast-check";
import type {ReactElement} from "react";
import {Alert} from "../Alert";
import {Avatar} from "../Avatar";
import {Code, Kbd, Mark, Skeleton, Tag} from "../atoms";
import {Badge} from "../Badge";
import {Button} from "../Button";
import {Card, Surface} from "../Card";
import {CountToggle} from "../CountToggle";
import {MetaRow} from "../MetaRow";
import {NumberInput} from "../NumberInput";
import {ScrollArea} from "../ScrollArea";

export interface InteractiveSpec {
	readonly kind: "interactive";
	/** CSS selector for the control inside the render root (button/a/input). */
	readonly selector: string;
	readonly arb: fc.Arbitrary<ReactElement>;
}

export interface PresentationalSpec {
	readonly kind: "presentational";
	readonly arb: fc.Arbitrary<ReactElement>;
}

export interface DeferredSpec {
	readonly kind: "deferred";
	readonly reason: string;
}

export type PrimitiveSpec = InteractiveSpec | PresentationalSpec | DeferredSpec;

/** A short, always-present, human-readable label so a control has an accessible name. */
const label = fc.constantFrom("Beğen", "Yanıtla", "Paylaş", "Gönder", "Kaydet", "Aç");
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

const numberInputArb: fc.Arbitrary<ReactElement> = fc
	.record({
		label,
		value: fc.integer({min: -100, max: 100}),
		disabled: fc.boolean(),
	})
	.map(({label: inputLabel, value, disabled}) => (
		<NumberInput label={inputLabel} value={String(value)} disabled={disabled} />
	));

const alertArb: fc.Arbitrary<ReactElement> = fc
	.record({
		variant: fc.constantFrom(...(["secondary", "success", "info", "danger"] as const)),
		children: text,
	})
	.map(({children, ...props}) => <Alert {...props}>{children}</Alert>);

const badgeArb: fc.Arbitrary<ReactElement> = fc
	.record({
		variant: fc.constantFrom(...(["primary", "secondary", "success", "info", "danger"] as const)),
		children: text,
	})
	.map(({children, ...props}) => <Badge {...props}>{children}</Badge>);

const scrollAreaArb: fc.Arbitrary<ReactElement> = text.map((children) => (
	<ScrollArea orientation="vertical">{children}</ScrollArea>
));

const COMPOUND_REASON =
	"Manti machine primitive — needs required items/trigger/content props or a portal interaction to render a representative surface; covered by composed-usage tests.";

/** EVERY runtime export of `../index.ts` — the coverage test fails on any drift. */
export const REGISTRY: Readonly<Record<string, PrimitiveSpec>> = {
	Button: {kind: "interactive", selector: "button", arb: buttonArb},
	CountToggle: {kind: "interactive", selector: "button", arb: countToggleArb},
	NumberInput: {kind: "interactive", selector: "input", arb: numberInputArb},

	Surface: {kind: "presentational", arb: surfaceArb},
	Card: {kind: "presentational", arb: cardArb},
	MetaRow: {kind: "presentational", arb: metaRowArb},
	Alert: {kind: "presentational", arb: alertArb},
	Avatar: {kind: "presentational", arb: avatarArb},
	Badge: {kind: "presentational", arb: badgeArb},
	ScrollArea: {kind: "presentational", arb: scrollAreaArb},
	Tag: {kind: "presentational", arb: tagArb},
	Code: {kind: "presentational", arb: inlineAtomArb(Code)},
	Kbd: {kind: "presentational", arb: inlineAtomArb(Kbd)},
	Mark: {kind: "presentational", arb: inlineAtomArb(Mark)},
	Skeleton: {kind: "presentational", arb: skeletonArb},

	Collapsible: {kind: "deferred", reason: COMPOUND_REASON},
	Dialog: {kind: "deferred", reason: COMPOUND_REASON},
	Menu: {kind: "deferred", reason: COMPOUND_REASON},
	Popover: {kind: "deferred", reason: COMPOUND_REASON},
	Tabs: {kind: "deferred", reason: COMPOUND_REASON},
	ToggleGroup: {kind: "deferred", reason: COMPOUND_REASON},
	Switch: {kind: "deferred", reason: COMPOUND_REASON},
	Tooltip: {kind: "deferred", reason: COMPOUND_REASON},
	TooltipProvider: {kind: "deferred", reason: COMPOUND_REASON},

	Form: {
		kind: "deferred",
		reason: "native form wrapper — needs labelled Manti controls in a composed fixture.",
	},
	Input: {
		kind: "deferred",
		reason: "Manti Input — accessible name comes from its required composed label prop.",
	},
	Textarea: {
		kind: "deferred",
		reason: "Manti Textarea — accessible name comes from its required composed label prop.",
	},

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
