# Build your first app with fabrika

In this lesson you take an app idea to its first working page. The app is Streakly, a small habit
tracker: one web page that lists three habits with a streak count beside each. You describe the
look, file the idea, and fabrika builds the page, checks it and adds it to your repo. It takes
about 20 minutes, and most of that is waiting while fabrika works.

Build Streakly as written, even if you have your own idea ready. Once you have done it once, the
same steps carry your own app.

You need:

- The repo you finished [Getting started with fabrika](getting-started.md) in, with its first pull
  request merged. A pull request is a proposed change to the repo that waits to be checked. Merging
  it adds the change to `main`, the repo's main line.
- fabrika's command-line tool at version 0.10.0 or later. `fabrika --version` prints yours.
- A web browser.

This lesson writes one file that step 9 of getting started also writes: the design rules. If you
did that step and the file is already on GitHub, read step 2 and then begin at step 4.

The lesson runs with screen review off, which is where a new repo starts. If you turned it on in
getting started, your run stops in step 7 to ask you for a screenshot, and step 9 says what to do
then.

Run every command from the root of your clone, on `main`. A command that starts with `/` is typed
into Claude Code, opened in that clone, not into a shell.

The samples below show what a run of this lesson prints. Where the run printed a web address, the sample
shows `<issue-url>` or `<pull-request-url>`, and yours will print the address of your own issue or
pull request. Your wording will differ too: the agents write their answers fresh each time.

The numbers follow on from getting started, which used 1 for its issue and 2 for its pull request.
Here the issue is 3 and its pull request is 4. If yours differ, use yours.

## 1. Say what the app looks like

fabrika's builder does not invent a look. It follows your design rules: a file named
`design-system-manifest.md` that states the colours, type and spacing every screen must keep to.

Open Claude Code in the clone and type:

```
/fabrika:front-door I am building a small habit tracker called Streakly. It will be one web page in plain HTML and CSS. It has a screen, so I think I need the design rules file. Can you help me with that?
```

It proposes a look in plain words and asks before it writes anything. In this run the answer
included:

```
- **Mood:** calm and encouraging, never nagging.
- **Colours:** warm off-white background, near-black text, one orange for streaks.
- **Type:** the system font, with big bold streak numbers.
- **Spacing:** roomy, one column, one habit per row.

Want me to write the design rules file with this look?
```

Ask for one change, so the look is yours, and say yes. Find the colour your proposal gives for
streaks, and pick a different colour you like better. Your message names both: the colour you want
first, then the colour it proposed. This run's proposal said orange, so the message was:

```
I like it, but make the streak colour green instead of orange. Then yes, write it.
```

Type that line with your two colours in it. The colour you asked for is your streak colour from here
on. Its answer began:

```
Done. The design rules file is written and checked: `design-system-manifest.md` at the repo root, with green (`#1B7F45`) as the streak colour.
```

The reply may go on to ask you a question, such as an offer to commit the file for you, and it may
name a command to run next. Do not answer the question and do not run that command. This lesson
commits the file in step 3 and gives you each command when you need it.

Open `design-system-manifest.md` and read it. It is short, and it is the whole brief the builder
gets for how Streakly looks. The file is on your machine only. Step 3 puts it on GitHub.

## 2. See that the screen check is off

fabrika can check a screen change by looking at the screen as well as reading the files. That is
screen review, and a new repo starts with it off. Nothing has to be set up for this lesson. Check
where your repo stands:

```bash
fabrika status settings
```

It prints one line for each setting. Find the one that starts `setting	reviewUi.mode`:

```
setting	reviewUi.mode	default	"skip"	no mode, uiSurfaces row, screens path or whenNoPreview rule is declared: screen review is not set up	2026-10-04T21:18:25Z
```

`"skip"` means screen review is not set up. fabrika will review Streakly's page by reading its
files, and the run will tell you plainly that it skipped the screen check. You look at the page
yourself in step 8. Step 9 shows the one command that turns screen review on, for when you want it.

## 3. Put the design rules on GitHub

The builder starts from what is on GitHub, so the file has to be there first. A commit is one
saved change in the repo's history. Make one:

```bash
git add design-system-manifest.md
git commit -m "Add design rules"
```

Push that commit to GitHub with `git push`.

## 4. File the idea

Describe the first page in two sentences. In Claude Code, type:

```
/fabrika:report The app has no screen yet. I want the first page of Streakly: one web page, plain HTML and CSS in index.html, that shows a list of three example habits (Read, Walk, Water) with a streak count next to each, following the design rules file.
```

Its answer began:

```
Filed: #3 <issue-url>

It's waiting for triage. I didn't build the page — report only files the request.

One gap I noted in the issue: you didn't give streak numbers, so the builder will pick sample ones.
```

One page is one issue. You do not need to split it up or plan it first.

## 5. Triage it

Triage turns your two sentences into something a builder can pick up cold. Type:

```
/fabrika:triage 3
```

It takes about two minutes. In this run its answer was:

````
Issue 3 is triaged. It is a new feature, priced p1, meaning it is worth pulling next, because nothing else can be built until a page exists.

What I changed on <issue-url>:
- **Body rewritten**, with the original kept underneath. It opens with a plain summary and a short pitch.
- **12 acceptance criteria added**, taken from `design-system-manifest.md`. Each one can be checked from the files, because screen review is not set up in this repo.
- **Home:** the "First arc" milestone. It waits on no other issue.
- **Labels:** `type:feature`, `p1`, `ready-for:agent`, `class:ui`, `class:doc`.
- **Scope:** I added a one-line README fix, because its "no app code yet" sentence goes stale once the page lands. The streak numbers are left to the builder as sample values.

**What happened:** the issue is ready for a builder, but the pitch check fails until you approve the pitch.

**What you do next:** post this as a comment on <issue-url>:

```
pitch-approved: appetite S
```

A pitch is a short proposal naming the problem, how much effort it is worth and what is left out. The size (`S`, `M` or `L`, small to large) is that effort budget. Work entering a build lane owes a pitch and your approval of its size, so the check blocks this issue until that comment is there, and a size changed later needs a new approval.
````

Open the issue on GitHub and read it. The section named "Pitch" is the proposal, and the list under
"Acceptance criteria" is what the finished page is graded against. Triage writes the criteria fresh
each time, so yours will be worded differently. None of them asks for a screenshot: triage read the
setting you saw in step 2, and with screen review off it writes only criteria that can be checked
from the files.

## 6. Approve the pitch

This is the moment you agree to the scope. Nothing gets built until you do.

On the issue's page on GitHub, paste this line into the comment box at the bottom and press
**Comment**:

```
pitch-approved: appetite S
```

## 7. Start the run

```
/fabrika:operate 3
```

`operate` carries one issue all the way through. It picks the right builder for an issue with a
screen, sends the pull request to review, and merges it. You watch.

This is the long step, about ten minutes. The run builds the page, opens pull request 4, reviews
it against the criteria and merges it. It does not stop for you. Its last lines were:

```
Issue 3 is done: <pull-request-url> was squash-merged into main as `48460c6e` and <issue-url> is closed. The screen check was skipped because screen review is not set up in this repo; to turn it on, run `fabrika status bootstrap hand-check-rule --screens <path>`, where <path> is the folder or file your screens live in.
Nothing is needed from you. If you want this repo on a project table, run `fabrika table setup` and then `fabrika table sync 3` from the repo root.

LANE-TERMINAL
```

`LANE-TERMINAL` means the run is over. The sentence about the screen check is the one to notice.
The reviewer read `index.html` and passed every criterion, and nobody looked at the page in a
browser. fabrika says so every time it skips that check, in those same words. Step 8 is where you
look.

Just above those lines the run says a table did not sync. A new repo has no project table, and
this lesson does not need one.

## 8. Open your app

Pull the merge into your clone:

```bash
git pull
```

Open `index.html` in your browser. On a Mac, `open index.html` does it. You see a `Streakly`
heading and three habits, Read, Walk and Water, each with a streak number in your streak colour.
Check it against your design rules: this is the look the review did not take. Streakly's first
page is in your repo.

## 9. Turn screen review on, when you want it

You can stop here. The lesson is done, and screen review can stay off for as long as you like.

When you want a person to see each screen change before it merges, one command turns that on. It
says that you will check the screen yourself, and that Streakly's screen lives in `index.html`:

```bash
fabrika status bootstrap hand-check-rule --screens index.html
```

```
status bootstrap: created .fabrika.jsonc for hand-check-rule with `reviewUi.mode` hand-check and 1 `reviewUi.screens` path(s), read-back conformed.
bootstrap	created	hand-check-rule	.fabrika.jsonc	ok
```

That wrote the setting into a new file, `.fabrika.jsonc`. Put it on GitHub:

```bash
git add .fabrika.jsonc
git commit -m "Turn screen review on"
```

Push that commit with `git push`.

From then on a run on a pull request that changes `index.html` stops at review and waits for you.
Its closing message says what to do: open the page, take a screenshot, and post it in a comment on
the pull request. The comment to paste is written out for you on the pull request. The run's
second closing line gives the command that starts it again.

## You are done

You wrote down a look, filed an idea in two sentences, approved its scope, and looked at the page
with your own eyes. fabrika wrote the page, reviewed it against the criteria and merged it.

Every page after this one takes steps 4 to 8 again: report, triage, approve, operate, open.
The design rules are already in place.

Where to go next:

- [`how-fabrika-works.md`](how-fabrika-works.md): why the builder, the reviewer and the merge step
  are separate, and why a run can stop and pick up again.
- [If your app has no preview deploys](adopt-fabrika-in-a-new-repo.md#if-your-app-has-no-preview-deploys):
  the three screen review settings in full, and what changes once your app has hosting.
- [`run-agents-under-a-second-account.md`](run-agents-under-a-second-account.md): keep steps like
  the pitch approval yours alone, by running the agents under a second GitHub account.
