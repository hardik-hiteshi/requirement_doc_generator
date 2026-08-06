# Dependency and external-service inventory

> Every runtime and infrastructure dependency through Phase 3, with its licence
> and its cost model.
>
> **This is not legal advice.** It records what each licence says and flags what
> a lawyer should look at. An open-source licence does not automatically permit
> every commercial use, and three entries below carry obligations that a
> deployment has to think about — they are marked **REVIEW**.

## The constraint

The core application must run with no paid third-party API, no managed SaaS and
no metered vendor service. Everything below is either an open-source library
running in this process, or open-source infrastructure running on hardware the
operator controls.

**Nothing in this inventory calls a vendor API.** There is no network egress to
any third party in the application's runtime path.

## Summary

| Category          | Component          | Paid? | Network egress | Mandatory                              |
| ----------------- | ------------------ | ----- | -------------- | -------------------------------------- |
| Database          | MongoDB Community  | No    | Self-hosted    | Yes                                    |
| Object storage    | MinIO              | No    | Self-hosted    | Only with `STORAGE_ADAPTER=s3`         |
| Object storage    | Local filesystem   | No    | None           | Only with `STORAGE_ADAPTER=filesystem` |
| Malware scanning  | ClamAV             | No    | Self-hosted¹   | Yes in production                      |
| OCR               | Tesseract          | No    | None           | Only for images and scans              |
| Legacy conversion | LibreOffice        | No    | None           | No — off by default                    |
| Queue             | MongoDB collection | No    | Self-hosted    | Yes                                    |
| AI (Phase 4)      | Ollama / vLLM      | No    | Self-hosted    | Not yet implemented                    |

¹ ClamAV's _signature updates_ fetch from the ClamAV project's mirrors. That is
free, unmetered, and can be pointed at an internal mirror or disabled entirely —
see the obligations section.

---

## Infrastructure services

### MongoDB Community Edition 8.0

|                |                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose        | Primary data store: projects, requirement sources, extracted content, jobs, audit events                                              |
| Licence        | **SSPL-1.0**                                                                                                                          |
| Commercial use | Permitted for running your own application                                                                                            |
| Execution      | Self-hosted container                                                                                                                 |
| Network        | Local only, bound to `127.0.0.1` in development                                                                                       |
| Cost           | Free software; server and storage cost is yours                                                                                       |
| Mandatory      | Yes                                                                                                                                   |
| Replacement    | The repository layer is thin, but Mongoose is used directly. A move to PostgreSQL would be a real project, not a configuration change |

> **REVIEW — SSPL.** The Server Side Public License is _not_ OSI-approved. Its
> section 13 requires anyone who offers **MongoDB itself as a service** to
> release the entire service stack under the SSPL. Running MongoDB as the
> database behind your own product is the ordinary, intended use and does not
> trigger it. If this application were ever offered as a hosted product,
> counsel should confirm the distinction — it is well-established but it is a
> licence question, not an engineering one. FerretDB or PostgreSQL are the
> Apache/PostgreSQL-licensed escape hatches if the answer is ever unwelcome.

### MinIO

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Purpose        | S3-compatible object storage for uploaded requirement files                                        |
| Version        | `RELEASE.2025-04-22T22-12-26Z`                                                                     |
| Licence        | **AGPL-3.0**                                                                                       |
| Commercial use | Permitted, with the obligation below                                                               |
| Execution      | Self-hosted container                                                                              |
| Network        | Local only; no cloud account, no AWS credentials                                                   |
| Cost           | Free software; disk cost is yours                                                                  |
| Mandatory      | Only when `STORAGE_ADAPTER=s3`                                                                     |
| Replacement    | Any S3-compatible server — Ceph RGW, Garage, SeaweedFS — works against the same adapter, unchanged |

> **REVIEW — AGPL.** Section 13 requires that users who interact with a
> _modified_ version **over a network** be offered its source. Running MinIO
> unmodified, as internal infrastructure that only this application talks to,
> does not engage that: your users interact with this application, not with
> MinIO. Do not patch MinIO without asking counsel first. Note also that MinIO
> has moved several console features behind a commercial licence in recent
> releases — this deployment uses only the S3 API and the basic console, neither
> of which is affected, and the pinned version above is the one that has been
> tested.

### ClamAV 1.4

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Purpose        | Malware scanning of uploaded files, before storage or extraction                                   |
| Licence        | **GPL-2.0**                                                                                        |
| Commercial use | Permitted                                                                                          |
| Execution      | Self-hosted container; spoken to over TCP, never linked                                            |
| Network        | Local for scanning. `freshclam` fetches signature updates from the ClamAV project's public mirrors |
| Cost           | Free software and free signatures. No subscription, no per-scan fee                                |
| Mandatory      | Yes in production — `MALWARE_SCANNER=none` is rejected at startup                                  |
| Replacement    | The port is small. Any scanner with a stream protocol fits behind it                               |

> GPL-2.0 is a linking concern, and there is no linking here: ClamAV runs as a
> separate process and this application speaks its wire protocol over a socket.
> That is the same relationship as talking to a database, and it does not make
> this application a derivative work.
>
> **Signature updates are an operational responsibility.** A scanner with stale
> signatures runs and detects progressively less. `freshclam` runs inside the
> container by default; an air-gapped deployment must mirror the definitions
> itself.

### Tesseract OCR 5.x

|                |                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose        | Text recognition for images and scanned PDF pages                                                                                             |
| Licence        | **Apache-2.0**                                                                                                                                |
| Commercial use | Permitted                                                                                                                                     |
| Execution      | Local binary, invoked as a subprocess                                                                                                         |
| Network        | **None.** No document ever leaves the machine                                                                                                 |
| Cost           | Free                                                                                                                                          |
| Mandatory      | Only for image and scanned-PDF sources. `OCR_ENABLED=false` refuses them cleanly                                                              |
| Replacement    | Behind `OcrProviderPort`. A cloud vision API would fit — and would violate the no-paid-service constraint, which is why it is not the default |

Language data (`tesseract-ocr-eng`, …) is Apache-2.0 or public domain depending
on the model; the English data shipped by Debian and Ubuntu is Apache-2.0.

### LibreOffice

|                |                                                     |
| -------------- | --------------------------------------------------- |
| Purpose        | Converting legacy `.doc` and `.xls`                 |
| Licence        | **MPL-2.0**                                         |
| Commercial use | Permitted                                           |
| Execution      | Local binary, invoked as a subprocess               |
| Network        | None                                                |
| Cost           | Free                                                |
| Mandatory      | **No.** Off unless `LEGACY_CONVERSION_ENABLED=true` |
| Replacement    | Behind `LegacyConversionPort`                       |

MPL-2.0 is file-level copyleft and applies to modifications of LibreOffice's own
files. Invoking it as a separate process creates no obligation.

---

## Runtime libraries

All MIT unless noted. None makes a network call to a third party.

| Package                                  | Version           | Purpose                                      | Licence    |
| ---------------------------------------- | ----------------- | -------------------------------------------- | ---------- |
| `@nestjs/*`                              | 11.x              | API framework                                | MIT        |
| `mongoose`                               | 9.9.1             | MongoDB ODM                                  | MIT        |
| `minio`                                  | 8.0.7             | S3-protocol client for the self-hosted store | Apache-2.0 |
| `multer`                                 | 2.2.0             | Multipart upload parsing                     | MIT        |
| `helmet`                                 | 8.3.0             | Response security headers                    | MIT        |
| `cookie-parser`                          | 1.4.7             | Cookie parsing                               | MIT        |
| `pino`, `pino-http`, `nestjs-pino`       | 10.x / 11.x / 4.x | Structured logging                           | MIT        |
| `zod`                                    | 4.4.3             | Schema validation, shared by both apps       | MIT        |
| `rxjs`                                   | 7.8.2             | Nest's async primitives                      | Apache-2.0 |
| `reflect-metadata`                       | 0.2.2             | Decorator metadata                           | Apache-2.0 |
| `next`                                   | 16.2.12           | Web framework                                | MIT        |
| `react`, `react-dom`                     | 19.2.8            | UI runtime                                   | MIT        |
| `@tanstack/react-query`                  | 5.101.4           | Server-state cache                           | MIT        |
| `react-hook-form`, `@hookform/resolvers` | 7.84 / 5.7        | Forms                                        | MIT        |
| `tailwindcss`                            | 4.3.3             | Styling                                      | MIT        |

### Document parsing and OCR support

| Package           | Version | Purpose                               | Licence      | Note                                                                                     |
| ----------------- | ------- | ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `pdfjs-dist`      | 6.2.108 | PDF text layer and page rendering     | Apache-2.0   | Mozilla's own PDF engine. Configured with `isEvalSupported: false` and no network access |
| `mammoth`         | 1.12.0  | DOCX → semantic HTML                  | BSD-2-Clause | No macro execution model at all                                                          |
| `exceljs`         | 4.4.0   | XLSX reading                          | MIT          | Formulas read as text, never evaluated                                                   |
| `@napi-rs/canvas` | 1.0.3   | Rasterising scanned PDF pages for OCR | MIT          | Prebuilt binaries — no compiler needed. Bundles Skia (BSD-3-Clause)                      |

CSV, plain-text and ZIP-container inspection are implemented in this repository,
which is why they have no entry: fewer dependencies on the code path that parses
hostile input is a deliberate choice, not an oversight.

---

## Development and CI dependencies

Not shipped to users; still worth recording, because a CI dependency on a paid
service would violate the constraint just as surely as a runtime one.

| Package                            | Version    | Purpose                         | Licence          | Note                                                                                  |
| ---------------------------------- | ---------- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `typescript`                       | 5.9.3      | Compiler                        | Apache-2.0       |                                                                                       |
| `turbo`                            | 2.10.8     | Task graph                      | MIT              | Telemetry disabled in CI                                                              |
| `eslint`, `typescript-eslint`      | 10.x / 8.x | Lint                            | MIT              |                                                                                       |
| `prettier`                         | 3.9.6      | Formatting                      | MIT              |                                                                                       |
| `jest`, `@swc/jest`                | 30.x       | API tests                       | MIT / Apache-2.0 |                                                                                       |
| `vitest`                           | 4.1.10     | Web and package tests           | MIT              |                                                                                       |
| `@playwright/test`                 | 1.62.1     | Browser tests                   | Apache-2.0       | Chromium downloaded from Playwright's CDN — free, and cacheable in an internal mirror |
| `@axe-core/playwright`, `axe-core` | 4.12.1     | Accessibility checks            | **MPL-2.0**      | See below                                                                             |
| `mongodb`                          | 7.5.0      | Direct driver, for E2E fixtures | Apache-2.0       |                                                                                       |
| `supertest`                        | 7.x        | HTTP integration tests          | MIT              |                                                                                       |

> **REVIEW — axe-core (MPL-2.0).** File-level copyleft: modifications to
> axe-core's own files must be published. It is used unmodified, as a test-time
> dependency, and is never distributed with the product — so no obligation
> arises. Deque also sells commercial axe products; the `axe-core` library used
> here is the free one, and nothing in this repository uses a paid Deque service.

---

## What is deliberately _not_ here

Each of these is a common default that this project refuses:

| Not used                                   | Why                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Anthropic / OpenAI / Gemini APIs           | Metered vendor APIs, and they would send client requirement documents off-site. Phase 4 uses self-hosted inference — ADR-0017 |
| AWS S3, Azure Blob, Google Cloud Storage   | Managed, metered. MinIO gives the same protocol on your own hardware                                                          |
| Cloud OCR (Textract, Vision, Azure OCR)    | Metered, and they receive the documents                                                                                       |
| Managed Redis                              | A second stateful service, and the managed versions are metered. The queue is a MongoDB collection — ADR-0012                 |
| Managed document-parsing APIs              | Metered, and they receive the documents                                                                                       |
| Commercial malware-scanning APIs           | Metered per scan. ClamAV is free and self-hosted                                                                              |
| Paid auth, observability, analytics, email | Not required by any feature in Phases 1–3                                                                                     |

The AWS SDK is **not** a dependency. The `minio` client speaks the S3 protocol
to a server you run; no AWS package, account or credential is involved anywhere
in this repository.

---

## Obligations, in one place

1. **Attribution.** MIT, BSD, and Apache-2.0 all require their notices to be
   preserved in any distribution. If this application is ever shipped as a
   binary or an image, generate and include a third-party notices file.
2. **Apache-2.0 NOTICE files.** Where a dependency ships one, it must be
   reproduced.
3. **MPL-2.0 (axe-core, LibreOffice).** File-level copyleft. Neither is modified
   here; modifying either creates a publication obligation for those files.
4. **GPL-2.0 (ClamAV).** Separate process, no linking, no obligation on this
   application. Do not statically link `libclamav`.
5. **AGPL-3.0 (MinIO).** Do not modify MinIO. Unmodified internal use is fine.
6. **SSPL (MongoDB).** Do not offer MongoDB itself as a service.
7. **Antivirus definitions** must keep updating, or the scanner silently
   degrades.
8. **Model licences (Phase 4).** Whichever model is chosen must permit
   commercial use, and its licence must be recorded here before it ships.
   Weights are never committed to Git.

## Keeping this current

`pnpm audit --prod` gates CI on advisories. This document is not generated, so a
new dependency must be added here in the same change that introduces it — a
reviewer noticing a `package.json` diff without a matching entry here should
treat that as an incomplete change.
