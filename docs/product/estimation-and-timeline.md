# Estimation and the timeline

Where the approved requirements and the locked technologies become hours, a team
and a schedule — and where you find out whether the deadline you asked for is
achievable.

## What it needs first

Three things, and it will not proceed without them:

- **an approved requirement baseline**, because estimating draft requirements is
  estimating something nobody has agreed to;
- **a locked technology stack**, because what a project is built with changes
  what it costs;
- **the delivery timeline you set**, because feasibility is measured against it
  and it is never guessed.

## Three numbers, not one

This is the part most estimates get wrong, so the screen keeps them apart.

**Effort** is hours of work. It is a property of the work alone — it does not
change when the team changes, and it does not change when the start date moves.

**Capacity** is hours available. Two people at six and a half hours a day for
four weeks is 260 hours.

**Duration** is elapsed time, and it comes from the other two _plus what has to
wait for what_. It is never effort divided by anything: work that must happen in
sequence stays in sequence however many people you add, and one backend engineer
cannot do four backend tasks at once however free the designers are.

## Where the numbers come from

Each requirement becomes a line with a **task category**, a **complexity** and an
**uncertainty**, and the hours follow from those through rules you can read.

**Complexity is explained, never asserted.** Each line lists what made it
complex — a multi-step workflow, a system we do not own, real-time behaviour —
and you can disagree with a specific driver rather than with a verdict. The
length of the requirement is not a driver and is never consulted: a one-line
requirement can describe a payment reconciliation, and a paragraph can describe
a footer.

**Uncertainty is separate from complexity**, because they are different things. A
payment flow against a documented API is complex and well understood. A one-line
integration with a system nobody has seen is simple and completely unknown, and
it is the second that wrecks plans.

**Every line has a range.** _If it goes well_, _expected_, _if it does not_. The
range widens with uncertainty rather than by a flat percentage, and it leans
towards the conservative side because software overruns more often than it comes
in early. Planning uses the expected figure; the other two are what the
conversation about risk uses.

## What it assumes about the team

Experienced engineers, roughly three to four years in — not people who have built
this exact system before, and not graduates. Working with AI assistance, which
reduces **repetitive construction**: scaffolding, boilerplate, the fourth CRUD
screen. It does not reduce understanding what the client meant, getting business
rules right, integrating with something you do not control, finding out why it is
wrong, reviewing it, or shipping it. So the discount is applied per kind of work,
and analysis and coordination get none at all.

**Six and a half productive hours a day, not eight.** The rest of a working day
goes on standups, reviewing other people's work, interruptions and context
switching. You can change it, and the number is on the screen rather than buried.

None of this appears in anything your client sees unless you turn it on.

## Delivery overhead

Named as activities rather than added as a percentage: environment setup, shared
architecture, the build pipeline, deployment preparation, code review, release
stabilisation, coordination, regression testing, UAT support.

Some scale with how much is built; some cost the same whatever the project size,
which is why small projects feel disproportionately expensive. Seeing that is
better than hiding it inside a number nobody can evaluate.

## The team

Optional. If you tell us who is working, we say whether the plan fits and flag
any role loaded past what a person sustains. If you do not, we say what the plan
would need instead — and the answer is often fractional. "About one and a half
days a week of a DevOps engineer" is a real answer; rounding it up to a full-time
person is how a recommendation stops being believable.

## The schedule

**Without a start date** you get working days: Day 1, Day 12, Week 3. That is a
complete answer, not a degraded one — nothing here invents a calendar you did not
supply.

**With a start date** the same schedule becomes real dates, skipping weekends and
any holidays you set.

**Moving the start date recalculates the dates and nothing else.** The hours, the
complexity, your overrides and the dependency graph are untouched, because none
of them ever depended on which Monday the work begins.

The **critical path** is marked, because it answers "why is it this long?" — and
because it tells you which tasks slipping actually moves the finish date.

## A deadline, and no start date yet

The commonest awkward case: the client has named the day it has to be delivered,
and nobody has agreed when work begins.

**The deadline is kept exactly as you set it**, from the first moment. It is
stored, displayed and carried forward, and nothing about the missing start date
changes it.

Everything that does not depend on a start date is calculated in full: the hours
per feature, the hours per role, the total, and how many working days the
sequenced work takes. Those numbers are final.

What is _not_ calculated is the fit — because a date is not a duration. Without a
start there is no span for the work to sit in, so the verdict reads **not yet
fully determinable**, and beside it is the one thing that would resolve it. No
dates are invented for the tasks, and no capacity is invented between "unknown"
and the deadline: an unmeasurable span reports no available hours rather than a
shortfall it cannot support.

The moment a start date arrives — tentative or confirmed — the same estimate
becomes dates, available working days, capacity and a verdict. **The hours, the
scope and the locked technologies do not move**, and neither does the deadline.
Set the start later and the fit gets worse; set it earlier and it gets better;
the delivery date stays exactly where the client put it.

A start date after the deadline is refused, from either side — setting the date or
moving the deadline. Two dates that cannot both be true is a mistake to point
out, not one to resolve on your behalf.

## Will it fit?

The verdict, measured against the timeline you set. **That timeline is never
changed** — not extended, not adjusted for realism, not quietly rounded up.

Where it does not fit you get the gap in the units it is actually in — hours
short, or working days over — the capacity that would close it, and the risks.
Then four options, all yours:

- add people;
- reduce scope, in the requirements step;
- accept the risk;
- move the date.

If the plan is tight or high risk, approving it requires you to say you have read
that. **Acknowledging is not agreeing the deadline is fine** — it records that you
are proceeding with your eyes open, and the risk goes into the documents. A
high-risk plan can absolutely be approved. It just cannot be approved by
accident.

## Changing a figure

Any line. Yours is authoritative from then on: re-estimating replaces everything
the application calculated and leaves everything you set exactly as it is. The
original is kept, so you can put it back without re-running anything.

You can also add a line by hand — for work the requirements do not describe but
you know is coming.

## When something upstream moves

If the requirements change, the stack is unlocked, or the timeline moves, the
estimate says so. **Nothing in it is recalculated.** It still says exactly what it
said, and you decide whether to re-estimate, adjust, or leave it.

## Your team, if you know it

Optional, and it stays optional.

**Without a team** you still get a full plan: the effort per role, the staffing the work
would need to meet your timeline — fractional where a fraction is the honest answer —
a schedule laid out against that derived capacity, and a feasibility verdict. Nobody has
to invent a team to see a date.

**With a team** the same plan is measured rather than projected. Per role you can say how
many people, how many productive hours a day, how many days a week, what percentage of
their time this project gets, and which working day they become available. Utilisation,
capacity gaps and the schedule are recalculated against what you actually have.

Removing the team returns you to the derived view. Changing it changes how long the work
takes and whether it fits — **it never changes the effort**, because who is doing the
work does not change what the work is.

## The working calendar

Every duration on the screen is hours divided by this, which makes it the quietest way
for a plan to be wrong.

Productive hours a day defaults to **six and a half, not eight** — eight hours of paid
time is not eight hours of engineering, and planning at eight is the most common way a
correct estimate becomes an incorrect schedule. You can change it, and the number is on
screen rather than buried.

Working days are named rather than counted, because a Sunday-to-Thursday week is normal
in much of the world. Non-working dates, client review days, UAT days and deployment days
are all here, because they are working days somebody has to wait through.

## What it is not good at

It is an estimate. The range is the honest part, and the expected figure is a
planning number rather than a measurement.

The dependency graph starts sparse — the application only infers what it can
defend, which means the schedule is optimistic until you add the sequencing you
know about. That is why the critical path is shown prominently, and why adding a
dependency is a one-click operation.

**The model reads requirements. It does not decide hours.** Every figure comes
from rules in this application, and every one of them can be overridden by you.
