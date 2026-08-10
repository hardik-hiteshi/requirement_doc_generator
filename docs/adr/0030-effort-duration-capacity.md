# 30. Effort, duration and capacity are three numbers, never one

Date: 2026-08-07

Status: Accepted

## Context

The single most common way a software plan goes wrong is an arithmetic mistake
that does not look like one:

```
1,250 hours ÷ 8 hours a day ÷ 5 people = 31 days ≈ 6 weeks
```

Every number in that line is real. The conclusion is not, and it fails in four
independent ways: nobody works eight productive hours; the five people are not
interchangeable; some of the work cannot start until other work finishes; and one
backend engineer cannot do four backend tasks at once however free the frontend
team is.

The division is tempting because the inputs are the ones a project manager has
to hand. It is what a spreadsheet does, and it is what a language model does if
asked "how long will this take?"

## Decision

**Three quantities, three calculations, three panels.**

- **Effort** — hours of work, from the estimate lines. A property of the work
  alone. It does not change when the team changes or when the start date moves.
- **Capacity** — hours available, from the team and the calendar. `people ×
productive hours × availability × working days`, per role.
- **Duration** — elapsed working days, from `buildSchedule` walking the
  dependency graph with per-role capacity. Never `effort ÷ anything`.

No function in the codebase takes effort and returns a duration. `buildSchedule`
takes tasks, dependencies, a calendar and people-per-role; there is no shorter
path, and `assessFeasibility` compares the schedule's length against the user's
timeline rather than deriving one from the other.

**The default day is 6.5 hours, and it is visible.** Eight hours of paid time is
not eight hours of engineering — there are standups, reviews of other people's
work, interruptions, and the twenty minutes after lunch. Planning at eight is how
a correct estimate becomes a wrong schedule, and it errs in the direction that
hurts. The number is a default the user can change, shown on the screen with the
reason beside it.

**Utilisation is flagged at 0.85, not 1.0.** A role planned at exactly its
theoretical capacity has no slack for a sick day, a production incident, or an
estimate that was slightly low — which is every project.

**Fractional people stay fractional.** "0.3 DevOps engineers" is a real answer,
and rounding every role up to a whole person is how a staffing recommendation
acquires two full-time engineers who are each needed for a day and a half. The
figure is shown with a sentence explaining it in days a week, because a reader
who cannot interpret it will round it up themselves.

**Schedules are computed in working-day offsets; dates are applied last.** That
is what makes "move the start date, recalculate the dates, leave the effort
alone" a one-line operation rather than a re-plan — and it means a project
without a start date gets a real schedule (Day 1, Day 12) rather than a degraded
one or an invented calendar.

## Consequences

The screen is longer. A reader who wants one number has to pass three panels to
get to a date, and that is the intended friction: the three panels are what make
the date mean anything.

Duration depends on the dependency graph, which is sparse by default — the
application infers only what it can defend (shared architecture before what sits
on it; testing after the thing being tested). A sparse graph makes the schedule
optimistic, so the phase reports the critical path prominently and lets a user
add the links they know about. An optimistic schedule a delivery lead can correct
beats a rich one nobody can read.
