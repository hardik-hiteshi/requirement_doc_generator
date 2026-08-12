# The documents

Where the approved requirements, the locked technologies and the approved estimate
become documents a client reads.

## What it needs first

Everything before it, approved. Not as bureaucracy — as the difference between a
document that means something and one that does not:

- **the requirement baseline you approved**, because a document describing draft
  requirements describes something nobody has agreed to;
- **the technology stack you locked**, where what the project is built with is
  relevant;
- **the estimate you approved**, because that is where the hours come from.

Each document says on its face what it was built from: "written against baseline
v3, estimate v2". A month later, when the baseline is at v7, that sentence is the
difference between a document you can trust and one you have to re-derive.

## Two documents, in order

**Our Understanding** comes first. **Feature Listing** is locked until Our
Understanding is approved, and the lock says so rather than being a greyed-out
button that explains nothing.

The other five — Acceptance Criteria, Assumptions, Statement of Work, Work
Breakdown Structure, Client Dependency Sheet — are listed and marked _not
available yet_. Seeing what is coming is more useful than seeing two documents and
wondering whether that is all there is.

## Our Understanding

The document that says, before anybody builds anything: _this is our formal
understanding of what you need._

Fifteen sections, fixed — overview, business objective, solution understanding,
users and roles, modules, workflows, functional scope, explicit non-functional
requirements, integrations, data and reporting, platforms, constraints, what is
explicitly out of scope, confirmed clarifications, open items. Fixed, because a
document whose headings change per project cannot be compared, reviewed against a
checklist, or explained.

**A section with nothing behind it stays empty, and says why.** A project with no
integrations gets "The approved requirements say nothing about this" rather than
"the system will integrate with third-party services as required" — a sentence
that means nothing and that somebody may later be held to.

**Nothing is invented.** No uptime figure, no response time, no user volume, no
compliance regime, no accessibility standard, no integration and no platform
unless the requirements say so. Those are the exact phrases that get written when
a section looks thin, so they are checked for rather than merely discouraged, and a
match blocks approval until it is dealt with.

**Nothing about how we work appears.** Not the tools, not the methodology, not
anything about AI. This is a document about what the client needs.

## Feature Listing

Every feature as a row: module, sub module, screen, what it does, and the hours per
role.

**The hours are the ones you approved.** Copied from the estimate, aggregated, and
checked against it — the panel tells you whether the two agree, and a document
whose totals have drifted cannot be approved. If you want a figure changed, that
happens in the estimation step, where it is a recorded decision that every document
then reflects. The document will not let you fork it quietly.

**A blank screen is a real answer.** An API endpoint is not a screen, and a
background job is not a screen. Calling one "Payments Screen" to fill a column puts
a fabrication in front of a client.

**Coverage is arithmetic, with its working shown.** How many requirements apply,
how many are in a feature, how many you deliberately excluded and why, and how many
nobody has decided about. That last number is what stops the percentage reaching
100 — and a requirement in no feature and on no exclusion list blocks approval,
because it is scope somebody will discover in month three.

You can edit the descriptive fields — module, sub module, screen, wording, notes.
Those are yours.

## Your writing wins

Edit any section and it becomes yours. From then on, a regeneration does not
overwrite it: the new text appears **beside** it, and you choose.

- keep what you wrote;
- use the new version;
- start from the new version and edit it.

All three are yours, and until you pick one the document says it is waiting for
you. A document with two versions of a section in it, one of them invisible, cannot
be approved.

Restoring an old version works the same way: it comes back as a new version, and
the version you were on stays exactly where it was. Nothing here can be rewound.

## Asking for something different

Any document, any section, any feature, any module: say what you want changed.

> "Make the Business Objective shorter."
> "Use client-facing wording."
> "Do not call this module Admin; call it Operations."
> "Regenerate only the Payments module."

What you asked and what came of it are kept with the version it produced, so
"why does version 4 read differently?" has an answer.

**A correction changes wording.** It cannot add a requirement, change a technology
or change an hours figure — those are decisions with their own steps, and a sentence
in a text box does not carry that authority. If you ask for one of them, the screen
says so and points at where it is actually done, rather than quietly doing half of
what you asked.

And if the section you are correcting is one **you** wrote, the rewrite arrives as a
suggestion beside it, not over it.

## Adding something the client just sent

Use **Add supporting source** on the documents step. It takes you to the
requirements step, because that is where requirements go in — through extraction,
review and a re-approved baseline. The document does not read it directly, and there
is no way to attach evidence to a document that the rest of the application has not
agreed to.

Once the baseline moves, every document says it is out of date, and you decide what
to regenerate.

## Rewriting part of the Feature Listing

One row, or one module. Everything outside the selection is left exactly as it is —
wording, your edits, and every hours figure. The hours cannot change here at all;
they are the estimate's.

A row you edited gets a suggestion rather than a replacement, the same as a section.

## Copying

**Copy the document** gives you the client-facing text: headings and prose. No
requirement ids, no source references, no internal notes, and no empty sections with
our reasoning in them.

**Copy with citations** is a separate button, for an internal review, and it adds
the requirement ids.

If you typed a requirement id into your own wording, the copy keeps your sentence as
you wrote it and tells you the id is in there — it will not quietly edit your text,
and it will not quietly send an identifier to a client either.

For the Feature Listing, **Copy to clipboard** gives you the export exactly: eight
columns in order, every value quoted, additional roles named, blank screens blank.

## Checks before approval

Running the checks is a step you take, and approving without it is refused —
approving something nobody checked is the failure this prevents.

What is checked is arithmetic: every citation points at a requirement that exists;
no rejected or superseded requirement appears; the baseline is the current one; the
hours match the estimate; coverage is complete; nothing contradicts itself; nothing
invented has crept in.

A model also reads the document back and may add a **warning** — an unsupported
statement, the same thing named two ways. It can never clear a finding or make one
less severe. Every finding says which of the two found it, so you can tell a fact
from a judgement.

**Blocking stops approval. A warning does not** — it is something to read, and
acknowledging it is recorded.

## Approved, and issued

**Approved** means agreed, and it unlocks whatever is built on it.

**Issued** is separate. It means the document left the building. An issued document
cannot be edited, regenerated, restored over or issued again — every one of those is
refused.

What you can do is **start a new version**. The issued one stays exactly as it was
sent, on the record, and the new version begins as a copy for you to work on. That
is why "which version did the client actually receive?" has an answer here.

### Issued, and out of date

A document has two labels, not one. **Issued** says what happened to it. **Out of
date** says whether the project has changed since. Both can be true at once, and
when they are, the document shows both:

> **Issued · Out of date**
> Issued previously. Project requirements or upstream decisions have changed since
> this version was issued.

It is still the version that was sent, word for word, with the baseline it was
written against still recorded against it. Nothing about it was edited, regenerated
or relabelled — the only thing that changed is what we tell you about it. Starting a
new version is how you move on; the issued one stays where it is.

The same is true one step earlier: an approved document whose inputs have moved is
**Approved · Out of date**. Still approved, because you approved it, and still
yours to edit or regenerate.

Neither approving nor issuing is possible while a document is out of date, and
neither button is offered.

Reopening Our Understanding marks Feature Listing out of date — and everything after
it in the sequence, all the way down. It does not regenerate any of them, change
them or delete them.

## When something upstream moves

If the requirements change, the stack is unlocked or the estimate is reopened, the
document says so — at the top, naming what changed and which version it was written
against.

**Nothing is recalculated.** It still says exactly what it said. You decide whether
to regenerate, edit, or leave it. A document that quietly rewrote itself the moment
something upstream moved would be a document nobody could review twice.

Regenerating it against the new version is what makes it current again. Re-approving
the document it was built on is not enough on its own — this document was written
against the version before, and nobody has read it since.

## Adding something new

If a new requirement turns up while you are reviewing a document, it goes in
through the requirements step — not into the document. It changes the baseline, the
baseline is re-approved, and everything downstream is marked out of date so you can
see what it affected. There is no path that puts a requirement into a document
without going through the requirements it is supposed to be based on.

## Acceptance Criteria

The conditions for accepting the work. Each one is something you could watch happen
and agree had happened — "the submitted timesheet appears in the manager's approval
list", not "the system works correctly".

**It is not a list of test cases.** No steps, no test data, no clicking. A test case
describes how somebody would check; a criterion describes what has to be true, and
that is the thing the client agrees to. Step-by-step detail appears only where a
requirement asks for it.

Some conditions read naturally as Given / When / Then, and those show that way.
Others — a retention rule, a permission, a reporting figure — do not, and forcing
them into a scenario makes them read as something a person does when they are not.
So the shape follows the condition rather than a template.

**Nothing here invents a number.** No response time, no availability percentage, no
concurrency figure, no browser version, no compliance standard — unless your
requirements state it, in which case the criterion quotes it. A figure that appears
from nowhere is a commitment nobody agreed to, and it blocks approval rather than
warning you about it.

Coverage counts what has a condition and what does not. A feature you deliberately
leave without one is a recorded decision, not a gap. A condition you add yourself is
marked as yours and asks where it came from, because one nobody can trace cannot be
agreed.

## Assumptions

What the plan is resting on, with somebody behind each one.

**A gap in the requirements is not an assumption.** If nobody said which currency,
that is a question to ask — and writing "we assume GBP" makes it look answered when
it is not. So an assumption gets in here only when its provenance says a person put
it there: the client stated it, you are stating it, or a clarification settled it.

That means a project where nobody has flagged anything gets an **empty** Assumptions
document, and that is a complete answer rather than a gap to fill.

**AI can suggest; only you can confirm.** Suggestions arrive marked as candidates,
say that nobody has stood behind them, and cannot reach an approved document. To
confirm one you say what it rests on — and that sentence is what makes the assumption
worth anything six months later, when somebody asks why the plan assumed it.

Each assumption records what would happen if it were wrong, in words. Not "this would
cost 40 hours", because nobody calculated that.

## Statement of Work

The commercial document. Scope from the approved Feature Listing, technology from the
locked stack, the timeline from the approved estimate, assumptions from the ones you
confirmed, acceptance pointing at the Acceptance Criteria.

**It is contract-ready in structure, and it is not a contract.** No governing law, no
warranty, no liability limitation, no payment terms, no penalties — none of it is
invented, and an attempt to write any of it blocks approval. What is missing is listed
as missing, so you can see what you still have to add before this becomes an
agreement.

**Nothing about how the work gets built.** No mention of AI, models or tooling. That
is a commercial decision for you to make deliberately, not something a generator
leaks by accident.

**The timeline is the estimate's.** If no start date is agreed, the document says
"approximately N working weeks following commencement" and contains no date at all. If
you set a deadline, that exact date appears. A timeline accepted as risky says so
rather than quietly substituting a safer one.

**Roles, not headcount.** "Backend engineering — API and server-side business logic",
never "two developers will be assigned", unless your capacity plan actually
established that.

## 6. Work Breakdown Structure

The plan you approved during estimation, arranged as work a delivery team can pick up:
project, phase, module, feature, task, indented so you can see what sits under what.

**The hours are the hours you approved.** Not recalculated, not re-rounded — copied,
and then checked. The first thing on the screen says whether the breakdown adds up to
your estimate role by role, and if it does not, it says which roles disagree and by how
much. A breakdown that quietly totalled something else would be planned against and
then found wrong.

**Days, not dates, unless you agreed a start date.** With no start date the plan reads
"days 4 to 9", because turning day 9 into a Tuesday would be inventing a commencement
you never agreed. Agree one and the real dates appear.

**The critical path is marked where the schedule put it.** So is the work that has
slack and can run alongside something else.

**Every task says which agreed features it delivers.** Taken from the feature listing you
approved, not guessed — and the panel says how many of your agreed features have work
against them. If one has none, it says so in red, because a feature that was sold and
not planned is the expensive kind of gap.

**Work that supports everything says so.** Environment setup, CI and release
stabilisation are marked as delivery overhead rather than being listed as features
nobody agreed to, or counted as features you are missing. Their hours are shown
separately.

**Each task shows what it is waiting on.** If a client dependency is holding a task up,
it appears on the task — and if the dependency sheet has gone out of date since, the row
says that too rather than letting you read a stale answer as a current one.

**You can reword anything and change the plan nowhere.** Rename a task, describe it
better, say what it produces. Try to move a start day and it says so, and points at the
estimation step — change it there, re-approve, regenerate, and the two documents still
agree. You _can_ move hours between roles or split a task; the document then tells you
it no longer adds up, and cannot be approved until it does.

## 7. Client Dependency Sheet

What the project needs from you, and by when.

**Asked for, arrived, and working are three different things.** An item you have sent
shows as "Received, not checked" until somebody has actually tried it, because
credentials arrive that were issued for the wrong environment and exports arrive in the
wrong encoding. Accepting an item asks what you checked and what it showed — that note
is what makes "we were unblocked on the 14th" mean something later.

**Every row is specific enough to hand over and to close.** No "client to provide all
required information": that is a line nobody can action and nobody can ever tick off.
Each row says what is needed, why, what good looks like, and what happens if it is late.

**Credentials are described, never carried.** A row will say that sandbox credentials
for your payment provider are needed, and where each stands. It never contains the key
itself — this sheet gets exported and emailed, and an issued version cannot be recalled.
Send secrets through your own secret manager.

**Nobody is named until you name them.** An owner guessed wrong in a client-facing sheet
is worse than an owner left blank.

**Unanswered questions are on it.** A clarification nobody has come back on is a
dependency on you, and leaving it off is how a project waits quietly for an answer
nobody knows is outstanding.

**You can issue it with things still outstanding.** That is the point — it is what you
send in order to ask.

## What it is not, yet

Copy-to-clipboard and the strict CSV preview work now. **Full DOCX, PDF and XLSX
export is a later phase** and is not implemented — the sheet you can preview here
is the exact eight-column schema that export will use, which is why it is built and
tested now.
