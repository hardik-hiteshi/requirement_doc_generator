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
