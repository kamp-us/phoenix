---
name: taste-animation-vocabulary
description: "Reverse-lookup glossary that turns a vague description of a motion effect into its exact term — \"the bouncy thing when a popover opens\" becomes Pop in, \"the iOS rubber-band scroll\" becomes Rubber-banding. Trigger on \"what's it called when…\", \"what is the term for that effect\", or when someone describes motion without knowing its name and needs the right word to brief an agent or a designer. For naming an effect only — for deciding whether to animate use taste-animation-opportunities, for judging an animation use taste-animation-review."
---

# taste-animation-vocabulary

Turn a vague description of a motion effect into the precise term, so the asker can name what they
want. Naming only — this skill does not design or build motion.

**Advice, not a gate.** A taste skill (ADR
[0209](https://github.com/kamp-us/phoenix/blob/main/.decisions/0209-taste-voice-per-aspect-skills.md))
— it posts no `review-*` marker and merges nothing.

## Grounding and firewall

Grounded exclusively in three artifacts, and there is no fourth:

- [`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md) — the four pillars, the prohibitions, the role tokens (ADR [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md)).
- [`design-system-inventory.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-inventory.md) — which primitives exist and when to use them (ADR [0194](https://github.com/kamp-us/phoenix/blob/main/.decisions/0194-design-law-jsdoc-firewall.md)).
- The blessed goldens — the visual reference a surface is measured against (ADR [0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)).

**This skill advises creation; it never authors law.** The firewall itself — the two-tier LAW /
CRAFT provenance rule and the obligation to say so and surface the gap where the law is silent — is
stated once, in [§2 of the library conventions](../taste-library-conventions.md#2-the-firewall--skills-advise-creation-they-never-author-law).
For this skill's output that means the glossary below is **CRAFT** vocabulary: naming an effect
never licenses it, and every named effect stays subject to the manifest's prohibitions and to the
gates in [`taste-animation-review`](../taste-animation-review/SKILL.md).

**It is also not the repo's term register.** Where a word also names a phoenix concept, the
repo's [`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md) and
[`.glossary/LANGUAGE.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/LANGUAGE.md) win.
These terms are English technical vocabulary; product and brand copy stays Turkish.

## How to answer

1. **Read for intent, not keywords.** People describe what they *see* or *feel* ("springy",
   "slides off", "draws itself in"), not the technical name. Map the sensation to the glossary.
2. **Quote the glossary verbatim.** Its descriptions are the authoritative wording — use them
   as-is.
3. **Disambiguate close terms.** When two compete (*Clip-path* vs *Mask*, *Pop in* vs *Bounce*,
   *Shared element transition* vs *Layout animation*), contrast them so the asker can pick.
4. **When nothing matches exactly,** name the closest term and say plainly that it is an
   approximation, or describe the effect in the glossary's own vocabulary ("that is a *stagger* of
   *scale-in* entrances").
5. **Stay inside the glossary.** If a term genuinely is not here, say so rather than inventing
   one.
6. **Keep it tight.** A naming question wants a name, not an essay. Lead with the term; expand
   only if asked.
7. **Flag a named effect the design law rules out.** If the term names motion the manifest
   prohibits or the frequency gate would reject, name the term and add one line saying so — the
   asker gets the word and the constraint together.

## Output shape

```
**Stagger** — Animate several items one after another with a small delay between each, creating a cascade.
```

When several terms fit, lead with the best match, then one or two alternates with a one-line note
on how they differ.

**Worked example — disambiguation.** "The thing where one image turns into another image."

```
**Morph** — One shape smoothly turns into another shape.

Close alternates:
- **Crossfade** — if they simply fade over each other in the same spot.
- **Shared element transition** — if an element travels and transforms from one position into another.
```

## Glossary

### Entrances and exits — how elements appear and disappear
- **Fade in / Fade out** — Element appears or disappears by changing opacity.
- **Slide in** — Element enters by sliding in from off-screen (left, right, top, or bottom).
- **Scale in** — Element grows from smaller to full size as it appears, often paired with a fade.
- **Pop in** — Element appears with a slight overshoot, like it bounces into place.
- **Reveal** — Content is uncovered gradually, often by animating a clip-path or mask.
- **Enter / Exit** — The animation an element plays when it is added to or removed from the screen.

### Sequencing and timing — coordinating multiple elements or moments
- **Keyframes** — Defined points in an animation (0%, 50%, 100%) that the browser fills the gaps between.
- **Interpolation / Tween** — Generating all the in-between frames between a start and end value, so motion is continuous.
- **Stagger** — Animate several items one after another with a small delay between each, creating a cascade.
- **Orchestration** — Deliberately timing multiple animations so they feel like one coordinated motion.
- **Delay** — Time before an animation starts.
- **Duration** — How long an animation takes.
- **Fill mode** — Whether an element keeps its first or last frame's styles before the animation starts or after it ends.
- **Stepped animation** — An animation divided into discrete steps, like a countdown timer.

### Movement and transforms — changing position, size, or angle
- **Translate** — Move an element along the X or Y axis.
- **Scale** — Make an element bigger or smaller.
- **Rotate** — Spin an element around a point.
- **Skew** — Slant an element along the X or Y axis, shearing it out of its rectangular shape.
- **3D tilt / Flip** — Rotate in 3D space (rotateX / rotateY) to add depth.
- **Perspective** — How strong the 3D effect looks — a lower value exaggerates depth, as if the viewer is closer.
- **Transform origin** — The anchor point a scale or rotation grows or spins from.
- **Origin-aware animation** — An element animates out of its trigger, like a popover growing from the button that opened it instead of from its own center, which is the CSS default.

### Transitions between states — connecting one state, view, or element to another
- **Crossfade** — One element fades out as another fades in, in the same spot.
- **Continuity transition** — A change that keeps the user oriented by visually connecting before and after.
- **Morph** — One shape smoothly turns into another shape.
- **Shared element transition** — An element travels and transforms from one position into another, like a thumbnail expanding into a card.
- **Layout animation** — When an element's size or position changes, it animates to the new spot instead of snapping.
- **Accordion / Collapse** — A section smoothly expands and collapses its height to show or hide content.
- **Direction-aware transition** — Content slides one way going forward and the opposite way going back, so navigation has a sense of direction.

### Scroll — motion tied to scrolling or navigating between views
- **Scroll reveal** — Elements fade or slide into place as they enter the viewport.
- **Scroll-driven animation** — An animation whose progress is tied directly to scroll position.
- **Parallax** — Background and foreground move at different speeds while scrolling, creating depth.
- **Page transition** — An animation that plays when navigating from one page or route to another.
- **View transition** — The browser morphs between two states or pages, connecting shared elements.

### Feedback and interaction — responding to the user's actions
- **Hover effect** — Visual change when the cursor moves over an element.
- **Press / Tap feedback** — A subtle scale-down when an element is clicked, so it feels physical.
- **Hold to confirm** — A progress effect that fills up while the user holds a button.
- **Drag** — Moving an element by grabbing it, often with momentum when released.
- **Drag to reorder** — Dragging items in a list to rearrange them, while the others shift to make room.
- **Swipe to dismiss** — Dragging an element off-screen to close it, like a drawer or toast.
- **Rubber-banding** — Resistance and snap-back when you drag past a boundary (the iOS overscroll feel).
- **Shake / Wiggle** — A quick side-to-side jitter signaling an error or rejected input.
- **Ripple** — A circle expanding from the point of a tap, confirming the press.

### Easing — how speed changes over an animation
- **Easing** — The rate at which an animation speeds up or slows down.
- **Ease-out** — Starts fast, ends slow. The default for most UI and anything responding to the user.
- **Ease-in** — Starts slow, ends fast. Usually avoided; feels sluggish on UI.
- **Ease-in-out** — Slow, fast, slow. Good for elements already on screen moving from A to B.
- **Linear** — Constant speed. Avoid for UI; reserve for spinners or marquees.
- **Cubic-bezier** — A custom easing curve defined for precise control.
- **Asymmetric easing** — A curve that accelerates and decelerates at different rates.

### Springs — physics-based motion as an alternative to fixed durations
- **Spring** — Motion driven by physics (tension, mass, damping) rather than a set duration.
- **Stiffness / Tension** — How strongly the spring pulls toward its target. Higher feels snappier.
- **Damping** — How quickly a spring settles. Lower damping means more bounce.
- **Mass** — How heavy the animated element feels. More mass is slower.
- **Bounce** — A spring that overshoots and settles, adding playfulness.
- **Perceptual duration** — How long a spring feels finished, even though it keeps micro-settling underneath.
- **Momentum** — Motion that carries velocity, especially after a drag or interruption.
- **Velocity** — How fast and in which direction an element is moving; a spring carries it into the next animation when interrupted.
- **Interruptible animation** — An animation that can be smoothly redirected mid-flight instead of finishing first.

### Looping and ambient motion — animations that run on their own
- **Marquee** — Text or content that scrolls continuously in a loop.
- **Loop** — An animation that repeats, a set number of times or infinitely.
- **Alternate (yoyo)** — A loop that plays forward then reverses each iteration.
- **Orbit** — An element circling around another in a continuous path.
- **Pulse** — A gentle repeating scale or opacity change to draw attention.
- **Float** — A gentle, continuous up-and-down drift that makes a static element feel weightless.
- **Idle animation** — Subtle motion that plays while an element sits waiting to be interacted with.

### Polish and effects — the small touches
- **Blur** — A blur filter used to soften an element or mask tiny imperfections.
- **Clip-path** — Clipping an element to a shape, used for reveals, masks, and before/after sliders.
- **Mask** — Hiding or revealing parts of an element using a shape or gradient — like clip-path, but with soft, fadeable edges.
- **Before / after slider** — A draggable divider that wipes between two overlaid images to compare them.
- **Line drawing** — An SVG path that draws itself in, like an invisible pen tracing it.
- **Text morph** — Text that animates character by character when it changes.
- **Skeleton / Shimmer** — A placeholder with a moving sheen shown while content loads.
- **Number ticker** — Digits rolling or counting up to a value.
- **Tabular numbers** — Fixed-width digits so numbers do not shift as they change. Essential for tickers, timers, and counters.
- **Typewriter** — Text appearing one character at a time.

### Performance — what keeps motion smooth
- **Frame rate (FPS)** — Frames drawn per second. 60fps is the baseline for smooth motion.
- **Jank** — Visible stutter when the browser drops frames.
- **Dropped frame** — A frame the browser missed its deadline to draw, causing a hitch.
- **Compositing** — Letting the GPU move or fade an element on its own layer without redoing layout or paint.
- **will-change** — A CSS hint that an element is about to animate, so the browser can promote it to its own layer ahead of time.
- **Layout thrashing** — Animating properties like width, height, top, or left, forcing the browser to recalculate layout every frame.

### Principles — concepts that guide when and how to animate
- **Purposeful animation** — Motion should serve a function — orient, give feedback, show relationships — not decorate.
- **Anticipation** — A small wind-up in the opposite direction before a move.
- **Follow-through** — Parts of an element keep moving and settle slightly after the main motion stops, adding weight.
- **Squash and stretch** — Deforming an element as it moves to convey weight and speed.
- **Perceived performance** — The right animation makes an interface feel faster, even when it is not.
- **Frequency of use** — The more often a user sees an animation, the shorter and subtler it should be.
- **Spatial consistency** — Animating so an element keeps its identity and position across states.
- **Hardware acceleration** — Animating transform and opacity lets the GPU keep motion smooth.
- **Reduced motion** — Respecting the user's `prefers-reduced-motion` setting.

## Attribution

Adapted from [`emilkowalski/skills`](https://github.com/emilkowalski/skills) (MIT, © 2026 Emil
Kowalski) — `skills/animation-vocabulary/SKILL.md`. Adapted for phoenix: the glossary is scoped as
CRAFT vocabulary subordinate to `.glossary/TERMS.md` and `.glossary/LANGUAGE.md`, a rule was added
to flag a named effect the design law rules out, the upstream sync-with-the-project's-vocabulary-page
note was dropped, and the upstream promotional links removed. Full license text:
[`taste-library-notice.md`](../taste-library-notice.md).
