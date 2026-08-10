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

**Issued** is separate and irreversible. It means the document left the building.
An approved document can be reopened and revised; an issued one is a matter of
record, and the only way past it is a new version. Collapsing the two is how
"which version did the client actually receive?" becomes unanswerable.

Reopening Our Understanding marks Feature Listing out of date. It does not
regenerate it, change it or delete it.

## When something upstream moves

If the requirements change, the stack is unlocked or the estimate is reopened, the
document says so — at the top, naming what changed and which version it was written
against.

**Nothing is recalculated.** It still says exactly what it said. You decide whether
to regenerate, edit, or leave it. A document that quietly rewrote itself the moment
something upstream moved would be a document nobody could review twice.

## Adding something new

If a new requirement turns up while you are reviewing a document, it goes in
through the requirements step — not into the document. It changes the baseline, the
baseline is re-approved, and everything downstream is marked out of date so you can
see what it affected. There is no path that puts a requirement into a document
without going through the requirements it is supposed to be based on.

## What it is not, yet

Copy-to-clipboard and the strict CSV preview work now. **Full DOCX, PDF and XLSX
export is a later phase** and is not implemented — the sheet you can preview here
is the exact eight-column schema that export will use, which is why it is built and
tested now.
