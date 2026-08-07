# Requirement analysis

> Your documents go in. A reviewed, traceable set of requirements comes out —
> drafted by a model running on this deployment's own hardware, and approved by a
> person.

## What it does

1. **Chunks** your reviewed documents, one document at a time, at headings where
   it can. Nothing is ever truncated: a paragraph too big for one chunk is split
   at a sentence boundary and every part is analysed.
2. **Reads each chunk** — normalises the statements, classifies them, extracts
   structured requirements with a quotation from the source.
3. **Reconciles across all of them**: duplicates, contradictions, vague wording,
   missing detail, inconsistent terminology, and the questions worth asking.
4. **Scores every requirement** on how well it is evidenced, and assembles a
   baseline you can review, correct and approve.

Step 3 is the one that matters most, and it is why the analysis is slower than a
single pass would be. A requirement stated in one document and contradicted in
another is invisible to each document alone.

## What it will not do

This is the part worth reading twice. **Nothing is decided on your behalf.**

| It found                    | It does                                      | It does not                       |
| --------------------------- | -------------------------------------------- | --------------------------------- |
| Two identical requirements  | Groups them, suggests which to keep          | Merge them                        |
| Two contradictory ones      | Shows both sides, quoted, with their sources | Pick a winner                     |
| Vague wording               | Names the phrase and says what is unclear    | Rewrite your client's requirement |
| A missing detail            | Says what is missing and why it matters      | Invent a plausible value          |
| Nothing in a block          | Records "no requirement here", with a reason | Leave it unaccounted for          |
| A question it cannot answer | Writes it for a business reader              | Answer it, or assume the answer   |

Every one of those "does not" columns is a decision that destroys information
only you have. An assumption filed as a fact is the most expensive error a
requirement document can carry — it looks exactly like something the client said,
right up until they read it.

## Two confidence figures

They are not the same thing, and they are never merged.

**Evidence** — calculated by the application from your documents. Does the
requirement link to a real block? Is the quoted wording actually there? Does it
point to a page or a row? Do two documents say it? Has a person checked it? This
is the figure that orders your review list and gates approval, and clicking
"Why?" shows you exactly what it is made of.

**AI self-assessment** — the model's own opinion of its own output. Shown,
because hiding it would be worse. It is not a probability, it affects nothing,
and the label says so every time it appears.

The gap between them is often the most useful thing on the screen. A requirement
marked "AI self-assessment 95%" and "Not evidenced" is one where the model was
confident about something it made up.

## Answering a question

A clarification answer is the most valuable thing in a requirements process: you
asked the client something directly and they told you. So it is treated as
evidence, not as a footnote.

**Answering and confirming are separate.** Answering records what you were told.
Confirming says _this is the client's answer_ — and that is what applies it. Until
you confirm, the question still blocks approval, because the requirements do not
yet reflect anything.

Confirming a fact updates the requirements the question was about, and each of
them then cites the clarification as a source. Ask _"which users can approve?"_,
confirm _"only Project Managers"_, and the requirement that said _"Users can
approve requests"_ comes to say so — traced to **Q-001**, with its evidence
confidence reflecting that somebody confirmed it.

**It does not become an assumption.** An assumption is something nobody
confirmed. Recording a confirmed fact as one understates what you know. If you
_are_ assuming — answering on the client's behalf because the call is next week —
say so when you answer, and it is recorded as an assumption, labelled, so they
can see what was taken for granted.

### What it will not overwrite

If the answer would change a requirement **you edited, wrote, or already
approved**, nothing is applied. You get a proposal instead: the current wording,
the proposed wording, why, and which question it came from. Accept it, keep what
you have, or write your own version.

### Changing your mind

Answer again and a new version is recorded. The old answer stays readable, the
requirements it changed are flagged for another look, and an approved baseline
goes out of date. Nothing in that baseline changes — it still says what it said
when it was approved.

### What it does to a contradiction

If the analysis found two statements that cannot both be true, and your answer
changes one of them, the contradiction is looked at again — just that one, and
the others it shares a requirement with. Nothing else is re-analysed.

It closes only when all of it is true: the answer is confirmed, it is a fact
rather than an assumption, it reaches this contradiction, it changed **every**
side of it, those changes are applied rather than waiting for you, and the model
agrees the answer speaks to what the two statements disagreed about. The model
can only object here — it can never be the reason something closes, and how
confident it says it is does not count for anything.

Anything short of that and the contradiction stays blocking, with a reason:
_"the answer changed part of this conflict but left one contradicting
requirement untouched"_. A contradiction nobody settled is not settled because a
question was answered nearby.

You can see what it used to say. Every contradiction keeps its original two
positions, their sources, and each status it has been through — including the
times it was re-checked and nothing changed.

### Setting a question aside

Some questions do not need answering: it was asked twice, the answer is already
in a document you uploaded, it does not apply, or the requirement it was about
has gone. You can set one aside, but not by simply saying so.

You pick which of those four it is, and for the two that point at something —
_the answer is already recorded somewhere else_ and _the requirement it was about
has gone_ — you say what, and it is checked. A document has to be in this
project. Another question has to have a **confirmed** answer. A requirement has
to actually be rejected or superseded. If the thing you point at does not check
out, the question is not dismissed and it keeps blocking.

## Coverage and alignment

**Coverage** is how much of your documents was accounted for — counted in blocks
of text, not in requirements found. A block that produced no requirement still
counts, provided the analysis said why. A block nothing ever read does not, and
it blocks approval.

**Alignment** is how well the baseline reflects what your documents said:
traceability, evidence quality, and how much is still unresolved. **It is capped
while anything is outstanding**, and it tells you why in plain language.
Generation finishing successfully does not earn a completeness claim.

## Approval

The baseline cannot be approved while any blocker remains, and each blocker says
what to do:

- a requirement with no link to any document;
- a requirement citing a document this project does not have;
- a requirement whose evidence is too weak to rely on;
- an unresolved contradiction;
- an unanswered question the baseline depends on;
- an undecided duplicate;
- a gap that stops something being implementable;
- part of a document that was never analysed.

Approving also asks you to confirm you have read it. A model drafted these; a
person is accountable for them, and the record says who.

## After approval

If a document changes — added, removed, corrected, re-reviewed — the approved
baseline is marked **out of date**. Nothing in it changes: it still says exactly
what it said when it was approved, because that is what was signed. Run the
analysis again and you get a new version; the old one stays readable.

Re-running keeps every requirement you edited or accepted. A new analysis
proposes; it does not overwrite your decisions.

## How long it takes

Longer than you expect, because the model is running on your hardware rather than
somebody's GPU farm. Roughly three inference calls per chunk plus six across the
whole project. On CPU with a 3B model that is a few minutes for a short brief and
considerably more for a long specification; on a GPU it is much faster.

The screen tells you which part of which document is being read. You can leave
the page and come back, and you can stop the analysis at any point — it stops
between steps, so nothing is left half-written.

## What it is not good at

The model is small, because it has to run on hardware you own. Expect it to miss
subtle contradictions between distant parts of a long document, and to sometimes
split one sentence into two requirements. This is a permanent trade-off of the
architecture, not a temporary gap.

That is why every stage is reviewable, why every requirement shows the words it
came from, and why the baseline cannot be approved with unresolved conflicts or
unanswered questions. **The model drafts. A person decides.**
