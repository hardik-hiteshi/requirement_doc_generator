# ADR-0015: A conversion boundary for .doc and .xls, disabled by default

## Status

Accepted (Phase 3)

## Context

`.doc` and `.xls` are pre-2007 binary formats. Reading them means either
reimplementing a decade of Microsoft's file layout or shelling out to an office
suite. Clients still send them.

The brief is explicit on the constraint that matters here: _"Do not claim native
support for legacy formats unless conversion is actually implemented and
tested."_

## Decision

**Define `LegacyConversionPort`, implement a LibreOffice adapter behind it, and
leave it off unless `LEGACY_CONVERSION_ENABLED` is set.**

While it is off, `.doc` and `.xls` are refused at validation with a message that
names the fix: _"Save the file as .docx or .xlsx and upload it again."_ Not a
generic rejection, and not silence.

Off by default because a converter is a several-hundred-megabyte dependency, and
no deployment should acquire one as a side effect of installing this application.
Enabling it is a deliberate act by someone who has decided the trade is worth it.

Where it is enabled, each conversion gets a throwaway LibreOffice profile
directory. LibreOffice keeps one shared profile by default and refuses to start a
second instance against it, so two concurrent conversions would deadlock and one
crash would leave a lock file that breaks every subsequent call.

## Consequences

- `.doc` and `.xls` are **not** listed as supported formats anywhere in the UI,
  the contract, or the documentation. They appear as a separate, conditional
  capability.
- The rejection path is tested and runs in CI. The conversion path is verified
  locally, where LibreOffice is installed, and is **not** exercised by CI —
  stated plainly in the completion report rather than implied to be covered.
- A deployment that enables conversion without installing the binary finds out at
  startup, from `isAvailable()`, rather than when a user uploads a file.

## Alternatives considered

**Install LibreOffice in CI and support the formats outright.** Rejected for this
phase: it adds a large dependency and minutes to every run, for two formats that
have had a supported replacement since 2007. Reasonable to revisit if real usage
shows clients sending them often.

**Reject `.doc` and `.xls` with no boundary at all.** Simpler, and rejected
because the brief asks for the abstraction, and because the decision about
whether conversion is worth its cost belongs to a deployment rather than to this
codebase.

**A JS `.doc` parser.** Rejected: the maintained options extract text without
structure, which loses the headings and tables that make a requirement document
worth reading.
