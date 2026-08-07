# Choosing the technology stack

The step where you decide what the project is built with, and commit to it. What
you lock here is what the estimate prices and what every document says.

## It starts from your approved requirements

Not from a draft. Technology decisions made against requirements nobody signed
off are guesses, so the step tells you to approve the baseline first and refuses
to approve a stack until you have.

It also needs to know **what kind of project this is** — that is what decides
which technologies even apply. If the project type has not been confirmed, it
asks rather than guessing.

## You choose how it gets filled in

**Choose everything myself.** You pick every technology. No AI is involved,
which means this works when no inference server is running at all. You can
approve and lock a stack this way and carry straight on to estimation.

**Let the AI suggest everything.** It proposes a technology for each category
your project needs, with a reason for each. Nothing is applied — every
suggestion waits for you to accept, reject or replace it.

**I'll choose some, the AI suggests the rest.** Anything you have already chosen
is left exactly as it is. The AI only looks at the categories still undecided.

## Your decisions are not overruled

This is the rule the whole step is built around.

If you choose React, Laravel and MySQL, the project uses React, Laravel and
MySQL. The AI is not asked about a category you have decided, and it could not
change one if it were.

What it can do — and will — is **tell you it disagrees**. A warning names the
technology, what the concern is, which of your requirements it touches, and what
the alternative would be. You then either change your choice or say you have
read it and are keeping it. Keeping it is a real option: the choice stands, the
warning goes on the record, and it appears in the estimate and the documents,
because a risk the client accepted belongs in what they signed.

The one thing you cannot wave away is a **direct contradiction with your own
approved requirements** — your documents say everything must be self-hosted and
the stack contains a service that cannot be. There is no acknowledgement button
for those, because the stack as written does not work.

## Only the categories your project actually has

A static website has no database. An API service has no frontend. An
Android-only app has no iOS framework. Those categories are not shown, not
suggested, and not counted as missing.

Some categories — a cache, a search engine, a message queue, a vector store, an
API gateway, container orchestration — are **never offered unless something in
your approved requirements asks for them**. A project being large is not a
reason. Each of them is infrastructure somebody runs, and pays for, for the life
of the project. They are still available behind _"Something else?"_ if you know
you need one.

In particular: an AI project does not automatically get a vector database. If
your requirements describe semantic search or retrieval, it appears. If they
describe classification, it does not.

## What you are told about each technology

**Licence and cost posture** come from a reviewed list this application
maintains, not from the AI. It says _how_ something charges — free when
self-hosted, pay-per-use, commercial licence — and never a price, because there
is no reliable source for today's prices and a made-up number in a proposal is
worse than none.

**Whether it can be self-hosted**, which matters if your client has a
data-residency or on-premise requirement.

**Where it came from**: your requirements, a confirmed clarification, a
constraint you set, your own preference, or the architecture. The last one is
labelled as such — if nobody asked for a technology and it simply follows from
other choices, the documents will not claim your client required it.

**Why the AI suggested it**, for suggestions: the reasoning, the benefits and
limitations for this project, the risks, what running it involves, and an
alternative. Alongside it, the model's own confidence — labelled as a
self-assessment, with the note that nothing in this application uses it to
decide anything.

## Something not on the list

Type it. A technology this application has never heard of is recorded exactly as
you typed it and treated as authoritative. It carries no licence or cost
information, and the screen says so rather than showing blanks that would look
like facts.

When you record something, say where it comes from: **your preference**, **the
client requires it**, or **already in place**. Those are different facts. A
client mandate becomes a constraint in the Statement of Work; existing
infrastructure becomes a client-provided dependency. A preference is neither.

## Approving, then locking

Two separate acts, deliberately.

**Approving** says these are the right technologies. It is refused while
anything is outstanding, and it tells you what: a category with no decision, a
suggestion nobody has looked at, a contradiction, an unacknowledged warning.

**Locking** says build and price exactly this. It is what estimation and every
later document read, and it asks you to confirm you understand that before it
happens.

Once locked, nothing changes it — not a new suggestion, not a document arriving,
not any automatic process.

## When the ground moves

If your requirements change after the stack was set — a document added, a
baseline superseded, a confirmed clarification changing what was asked for — the
stack is marked out of date. **Nothing in it is altered.** It still says exactly
what it said, and you decide whether to revalidate it, ask for suggestions again
for the affected categories, or keep what you have.

Unlocking works the same way: the locked version is kept and superseded, you
work on a new version, and anything built on the old one is flagged as stale.
You are asked why you are reopening it, because a change nobody explained is one
nobody can review.

## What it is not good at

The suggestions come from a small model running on your own hardware. It is
choosing from a reviewed list rather than reasoning from first principles, and
its rationale is worth reading rather than trusting.

That is why every suggestion waits for you, why the commercial facts come from a
list a person maintains rather than from the model, and why nothing you decide
can be overwritten. **The model suggests. You decide.**
