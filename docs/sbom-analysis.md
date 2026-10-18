---
title: "SBOM Analysis: DumpFire"
category: "Identity & Security"
version: 1.4
status: As-Built
date: 2026-10-18
tags:
  - sbom
  - licensing
  - compliance
  - open-source
  - audit
  - security
  - fonts
  - jsdom
  - dompurify
  - nodemailer
  - sveltekit
  - devalue
description: "Software Bill of Materials and open-source posture analysis for the DumpFire Kanban board application, with the changes of 2026-10-15 (jsdom for the tests, dompurify raised to 3.4.17, the Inter font bundled under the SIL Open Font License 1.1) and of 2026-10-18 (nodemailer 8.0.7 to 10.1.1, @types/nodemailer removed; @sveltejs/kit 2.60.1 to 2.70.3, svelte 5.55.7 to 5.57.2, @sveltejs/adapter-node 5.5.4 to 5.5.7, devalue 5.8.1 to 5.9.4, qs 6.15.1 to 6.16.0 by an override)"
---

# SBOM Analysis: DumpFire

Based on production dependency analysis via `license-checker` and `npm audit` (scanned 2026-05-15, post-update), here is an architectural summary and open-source posture analysis of the DumpFire application. The counts and tables of sections 2 to 6 are that scan's. What changed on 2026-10-15 (cards 2202 and 2203) is in [section 9](#9-changes-on-2026-10-15), and what changed on 2026-10-18 (card 2227) in [section 10](#10-changes-on-2026-10-18); each is folded into the rows it touches below.

## 1. Application Summary

DumpFire is a self-hosted, real-time **Kanban board** built for teams on a local network. It is a full-stack **SvelteKit 5** (Runes) web application running on **Node.js 22**, backed by an embedded **SQLite** database. By analysing its dependency tree, we can deduce its core architecture and capabilities:

**UI Framework (SvelteKit 5 + Svelte Runes):** The frontend is a server-rendered SvelteKit application using the Svelte 5 Runes reactivity model. The `@sveltejs/adapter-node` compiles the app into a standalone Node.js server, containerised via a multi-stage Dockerfile. Drag-and-drop Kanban interactions are powered by `svelte-dnd-action`. Rich text rendering uses `marked` (Markdown parser) with `dompurify` for XSS sanitisation, both through one module, `src/lib/markdown.ts`, which configures DOMPurify for descriptions and comments (card 2202). Text is set in Inter, a font bundled with the application and served by it (card 2203), not fetched from Google.

**Data Layer (SQLite + Drizzle ORM):** All data is stored in a single SQLite file via `better-sqlite3` (a synchronous, native N-API binding). Schema management and queries use `drizzle-orm` with `drizzle-kit` for migration generation. WAL mode is enabled for concurrent read performance.

**Authentication & Security:** User passwords are hashed with `bcryptjs` (BSD-3-Clause, pure JS). Session-based auth with 30-day sliding windows, API key bearer tokens, and rate limiting are implemented in server hooks. Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection) are applied globally, and every page carries a Content-Security-Policy with a nonce per page (card 2162).

**Cloud Backup Providers:** The backup system supports four destination providers via dedicated SDK integrations:

- **Amazon S3** — `@aws-sdk/client-s3` (the largest dependency subtree at ~50 packages)
- **Google Drive** — `googleapis` + `google-auth-library`
- **Microsoft OneDrive** — `@azure/identity` + `@microsoft/microsoft-graph-client`
- **SFTP/SCP** — `ssh2-sftp-client` + `ssh2`

**Email Notifications:** `nodemailer` provides SMTP transport for styled HTML notification emails (card moves, assignments, comments, backup failures).

**Document Generation:** `pdfkit` (with `fontkit`, `linebreak`, `png-js` sub-dependencies) generates PDF reports for board analytics and exports.

**Data Visualisation:** `d3-force` powers the interactive graph/relationship view with force-directed layouts.

**Real-Time Sync:** Server-Sent Events (SSE) push updates to connected browsers — no WebSocket or polling library required; this is implemented with native Node.js streams.

## 2. Open Source Posture

Overall, the open-source posture of DumpFire is **excellent and commercially compliant**, relying almost entirely on permissive licences with no copyleft risk. The application consumes **310 total packages** (237 production, 73 dev-only).

### Licence Distribution

| Licence | Production | Dev-Only | Total | Risk Level |
|---|---|---|---|---|
| MIT | 151 | 66 | 217 | ✅ Very Low |
| Apache-2.0 | 62 | 2 | 64 | ✅ Very Low |
| ISC | 10 | 1 | 11 | ✅ Very Low |
| BSD-3-Clause | 5 | 2 | 7 | ✅ Very Low |
| 0BSD | 1 | 0 | 1 | ✅ Very Low |
| MIT-0 | 1 | 0 | 1 | ✅ Very Low |
| Unlicense | 1 | 0 | 1 | ✅ Very Low |
| MPL-2.0 | 0 | 2 | 2 | ⚠️ Dev-only (see §3) |
| Dual/Multi-licence | 5 | 0 | 5 | ⚠️ See §3 |
| **Total** | **237** | **73** | **310** | |

> [!IMPORTANT]
> **Copyleft Risk: None.** There are no GPL, AGPL, or LGPL licensed components in this SBOM. There is no "viral" risk requiring the source code of DumpFire to be open-sourced. The two MPL-2.0 packages (`lightningcss`, `lightningcss-win32-x64-msvc`) are dev-only build tools — they are not bundled into the production artefact.

## 3. Packages Requiring Licence Clarification

Eight packages use dual/multi-licence or non-standard SPDX identifiers. Each has been manually reviewed:

| Package | Version | Declared Licence | Status | Notes |
|---|---|---|---|---|
| dompurify | 3.4.17 (range `^3.4.17` since 2026-10-15) | (MPL-2.0 OR Apache-2.0) | ✅ Compliant | Dual-licensed. The Apache-2.0 option is selected, which is fully permissive. MPL-2.0 is file-level copyleft but the OR clause allows choosing Apache-2.0 instead. |
| pako | 1.0.11 | (MIT AND Zlib) | ✅ Compliant | Dual-licensed under both MIT and Zlib. Both are maximally permissive. Zlib licence permits use in commercial software without attribution. |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | ✅ Compliant | Triple-licensed. Any of the three options is permissive. MIT is the most common selection. |
| expand-template | 2.0.3 | (MIT OR WTFPL) | ✅ Compliant | Dual-licensed. MIT is the standard selection. WTFPL is maximally permissive. |
| tweetnacl | 0.14.5 | Unlicense | ✅ Compliant | Public domain dedication. No restrictions whatsoever. Used by `ssh2` for cryptographic primitives. |
| png-js | 1.1.0 | MIT* | ✅ Compliant | The asterisk indicates the licence was inferred from the LICENSE file rather than package metadata. Confirmed MIT on GitHub. |
| url-template | 2.0.8 | BSD* | ✅ Compliant | Inferred BSD-3-Clause from the LICENSE file. Used by `googleapis-common`. |
| nodemailer | 10.1.1 | MIT-0 | ✅ Compliant | MIT No Attribution — even more permissive than standard MIT. No attribution requirement. |
| lightningcss | 1.32.0 | MPL-2.0 | ✅ Dev-only | Mozilla Public Licence 2.0 (file-level copyleft). Dev-only CSS build tool, **not bundled** into production. No compliance impact. |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | ✅ Dev-only | Native binary for lightningcss. Same MPL-2.0, same dev-only status. |

## 4. Complete Production Dependency Inventory

The following tables list all 237 production-scoped packages compiled into the production application, grouped by functional area.

### UI Framework — SvelteKit & Svelte (MIT)

| Package | Version | Integration |
|---|---|---|
| svelte | 5.57.2 | Bundled — reactive UI framework (5.55.7 until 2026-10-18: section 10) |
| @sveltejs/acorn-typescript | 1.0.13 | Bundled — TypeScript parser for Svelte |
| acorn | 8.19.0 | Bundled — JavaScript parser |
| esrap | 2.4.0 | Bundled — code generation |
| esm-env | 1.2.2 | Bundled — environment detection |
| locate-character | 3.0.0 | Bundled — source location |
| zimmerframe | 1.1.4 | Bundled — AST walker |
| magic-string | 0.30.21 | Bundled — string manipulation |
| is-reference | 3.0.3 | Bundled — AST reference detection |
| aria-query | 5.3.1 | Bundled — a11y role mapping (Apache-2.0) |
| axobject-query | 4.1.0 | Bundled — a11y object mapping (Apache-2.0) |
| devalue | 5.9.4 | Bundled — data serialisation (5.8.1 until 2026-10-18: section 10) |
| clsx | 2.1.1 | Bundled — class name utility |

### Data Access — SQLite + Drizzle (MIT + Apache-2.0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| better-sqlite3 | 12.10.0 | MIT | Linked — native SQLite3 binding |
| drizzle-orm | 0.45.2 | Apache-2.0 | Linked — type-safe ORM |
| bindings | 1.5.0 | MIT | Linked — native addon loader |
| prebuild-install | 7.1.3 | MIT | Linked — prebuilt binary installer |
| node-abi | 3.89.0 | MIT | Linked — Node ABI compatibility |

### Authentication & Security (MIT + BSD-3-Clause)

| Package | Version | Licence | Integration |
|---|---|---|---|
| bcryptjs | 3.0.3 | BSD-3-Clause | Linked — password hashing |
| jsonwebtoken | 9.0.3 | MIT | Linked — JWT handling |
| jwa | 2.0.1 | MIT | Linked — JSON Web Algorithms |
| jws | 4.0.1 | MIT | Linked — JSON Web Signatures |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | Linked — ECDSA signature formatting |

### Email (MIT-0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| nodemailer | 10.1.1 | MIT-0 | Linked — SMTP email transport, with its own type declarations (8.0.7 until 2026-10-18: section 10) |

### Markdown & Sanitisation (MIT + MPL-2.0/Apache-2.0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| marked | 18.0.3 | MIT | Bundled — Markdown to HTML parser |
| dompurify | 3.4.17 | (MPL-2.0 OR Apache-2.0) | Bundled — HTML sanitiser. `package.json` asks for `^3.4.17` since 2026-10-15 (it was `^3.3.3`, which admitted the release before 3.4.3's fix of a `FORBID_TAGS` bypass, and the renderer relies on `FORBID_TAGS`; then `^3.4.3`, below the releases that clear the advisories `npm audit` listed that day) |

### Font — Inter (OFL-1.1, bundled, not an npm package)

| Asset | Version | Licence | Integration |
|---|---|---|---|
| Inter, seven `woff2` files under `src/lib/fonts/inter/` (cyrillic-ext, cyrillic, greek-ext, greek, vietnamese, latin-ext, latin; 218,512 bytes) | 4.001 | OFL-1.1, "Copyright 2016 The Inter Project Authors", no Reserved Font Name | Bundled — served by DumpFire from `/_app/immutable/assets/`. Taken from the tarball of `@fontsource-variable/inter@5.3.0` (`npm pack` in a scratch folder; nothing installed, so it is in neither `package.json` nor the lock), and each file compared by SHA-256 with what Google Fonts served on 2026-10-15: identical. The licence's text is `static/licences/inter-OFL.txt`, served at `/licences/inter-OFL.txt`, as the OFL asks of a bundled copy |

### PDF Generation (MIT)

| Package | Version | Integration |
|---|---|---|
| pdfkit | 0.18.0 | Linked — PDF document builder |
| fontkit | 2.0.4 | Linked — font parsing |
| linebreak | 1.1.0 | Linked — Unicode line breaking |
| png-js | 1.1.0 | Linked — PNG decoding |
| brotli | 1.3.3 | Linked — Brotli compression |
| browserify-zlib | 0.2.0 | Linked — zlib for browser/node |
| pako | 1.0.11 | Linked — inflate/deflate (MIT AND Zlib) |
| unicode-properties | 1.4.1 | Linked — Unicode character data |
| unicode-trie | 2.0.0 | Linked — Unicode trie structures |
| restructure | 3.0.2 | Linked — binary data parsing |
| dfa | 1.2.0 | Linked — DFA engine |
| tiny-inflate | 1.0.3 | Linked — inflate decompression |
| clone | 2.1.2 | Linked — deep clone utility |

### Data Visualisation (ISC)

| Package | Version | Integration |
|---|---|---|
| d3-force | 3.0.0 | Bundled — force-directed graph layout |
| d3-dispatch | 3.0.1 | Bundled — event dispatching |
| d3-quadtree | 3.0.1 | Bundled — spatial indexing |
| d3-timer | 3.0.1 | Bundled — animation timing |

### Drag & Drop (MIT)

| Package | Version | Integration |
|---|---|---|
| svelte-dnd-action | 0.9.69 | Bundled — drag-and-drop for Svelte |

### AWS SDK — S3 Backups (Apache-2.0, ~50 packages)

All `@aws-sdk/*`, `@smithy/*`, and `@aws-crypto/*` packages are Apache-2.0, published by AWS. Key packages:

| Package | Version | Integration |
|---|---|---|
| @aws-sdk/client-s3 | 3.1047.0 | Linked — S3 object storage client |
| @aws-sdk/core | 3.974.10 | Linked — SDK core |
| @aws-sdk/credential-provider-node | 3.972.41 | Linked — credential chain |
| @aws-sdk/middleware-sdk-s3 | 3.972.39 | Linked — S3 middleware |
| @aws-sdk/xml-builder | 3.972.24 | Linked — XML serialisation |
| @smithy/core | 3.24.2 | Linked — Smithy runtime |
| @smithy/types | 4.14.1 | Linked — type definitions |
| @smithy/node-http-handler | 4.7.2 | Linked — HTTP handler |
| @smithy/signature-v4 | 5.4.2 | Linked — request signing |
| @aws-crypto/sha256-js | 5.2.0 | Linked — SHA-256 hashing |

*Plus additional `@aws-sdk/*`, `@smithy/*`, and `@aws-crypto/*` middleware, utility, and provider packages — all Apache-2.0.*

### Azure SDK — OneDrive Backups (MIT)

| Package | Version | Integration |
|---|---|---|
| @azure/identity | 4.13.1 | Linked — Azure AD authentication |
| @azure/msal-node | 5.2.1 | Linked — MSAL token acquisition |
| @azure/msal-browser | 5.10.1 | Linked — browser auth flows |
| @azure/msal-common | 16.6.1 | Linked — shared MSAL core |
| @azure/core-rest-pipeline | 1.23.0 | Linked — HTTP pipeline |
| @azure/core-auth | 1.10.1 | Linked — auth abstractions |
| @azure/core-client | 1.10.1 | Linked — client base |
| @azure/core-util | 1.13.1 | Linked — shared utilities |
| @azure/core-tracing | 1.3.1 | Linked — distributed tracing |
| @azure/logger | 1.3.0 | Linked — logging |
| @azure/abort-controller | 2.1.2 | Linked — cancellation |

### Microsoft Graph — OneDrive API (MIT)

| Package | Version | Integration |
|---|---|---|
| @microsoft/microsoft-graph-client | 3.0.7 | Linked — Graph API client |
| @babel/runtime | 7.29.2 | Linked — runtime helpers |
| @typespec/ts-http-runtime | 0.3.5 | Linked — HTTP runtime |

### Google APIs — Drive Backups (Apache-2.0)

| Package | Version | Integration |
|---|---|---|
| googleapis | 171.4.0 | Linked — Google API client |
| googleapis-common | 8.0.1 | Linked — shared API utilities |
| google-auth-library | 10.6.2 | Linked — Google auth |
| gaxios | 7.1.4 | Linked — HTTP client |
| gcp-metadata | 8.1.2 | Linked — GCP metadata service |
| google-logging-utils | 1.1.3 | Linked — logging utilities |

### SSH/SFTP — SFTP Backups (MIT + Apache-2.0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| ssh2-sftp-client | 12.1.1 | Apache-2.0 | Linked — SFTP operations |
| ssh2 | 1.17.0 | MIT | Linked — SSH2 protocol |
| asn1 | 0.2.6 | MIT | Linked — ASN.1 parsing |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause | Linked — key derivation |
| tweetnacl | 0.14.5 | Unlicense | Linked — NaCl crypto |
| cpu-features | 0.0.10 | MIT | Linked — CPU detection |
| buildcheck | 0.0.7 | MIT | Linked — build tooling |
| nan | 2.26.2 | MIT | Linked — native abstractions |

### Cryptography (MIT)

| Package | Version | Integration |
|---|---|---|
| @noble/ciphers | 1.3.0 | Linked — symmetric ciphers |
| @noble/hashes | 1.8.0 | Linked — hash functions |

### Networking & HTTP Utilities (MIT)

| Package | Version | Integration |
|---|---|---|
| node-fetch | 3.3.2 | Linked — HTTP client |
| agent-base | 7.1.4 | Linked — proxy agent base |
| http-proxy-agent | 7.0.2 | Linked — HTTP proxy |
| https-proxy-agent | 7.0.6 | Linked — HTTPS proxy |
| debug | 4.4.3 | Linked — debug logging |
| ms | 2.1.3 | Linked — time parsing |
| open | 10.2.0 | Linked — open URLs |

### Shared Utilities (MIT + ISC + Apache-2.0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| tslib | 2.8.1 | 0BSD | Linked — TypeScript helpers |
| @swc/helpers | 0.5.21 | Apache-2.0 | Linked — SWC runtime |
| uuid | 8.3.2 | MIT | Linked — UUID generation |
| semver | 7.7.4 | ISC | Linked — version parsing |
| fast-deep-equal | 3.1.3 | MIT | Linked — deep equality |
| json-bigint | 1.0.0 | MIT | Linked — BigInt JSON |
| bignumber.js | 9.3.1 | MIT | Linked — arbitrary precision |
| qs | 6.16.0 | BSD-3-Clause | Linked — query string parsing, through googleapis-common; held at 6.16.0 by an override since 2026-10-18 (6.15.1 before: section 10) |
| bowser | 2.14.1 | MIT | Linked — browser detection |
| buffer | 5.7.1 | MIT | Linked — Buffer polyfill |
| readable-stream | 3.6.2 | MIT | Linked — streams polyfill |

### Type Definitions (MIT)

| Package | Version | Integration |
|---|---|---|
| @types/better-sqlite3 | 7.6.13 | Types — SQLite bindings |
| @types/node | 25.8.0 | Types — Node.js |
| @types/estree | 1.0.9 | Types — ESTree AST |
| @types/pdfkit | 0.17.6 | Types — PDFKit |
| @types/trusted-types | 2.0.7 | Types — Trusted Types |
| @nodable/entities | 2.1.0 | Types — XML entity parsing |
| undici-types | 7.26.0 | Types — Undici HTTP |

## 5. Dev-Only Dependencies (73 packages)

The following packages are used exclusively for development and build tooling. They are **not bundled** into the production Docker image (pruned via `npm ci --omit=dev` in the Dockerfile build stage):

| Category | Key Packages | Licence |
|---|---|---|
| **SvelteKit Tooling** | @sveltejs/kit 2.70.3, @sveltejs/adapter-node 5.5.7 (2.60.1 and 5.5.4 until 2026-10-18: section 10), @sveltejs/adapter-auto 7.0.1, @sveltejs/vite-plugin-svelte 7.1.2 | MIT |
| **Build System** | vite 8.0.13, rollup 4.60.4, rolldown 1.0.1, esbuild (0.25.12, 0.28.0), @rollup/plugin-* | MIT |
| **CSS Processing** | lightningcss 1.32.0, postcss 8.5.14 | MPL-2.0 / MIT |
| **TypeScript** | typescript 5.9.3, svelte-check 4.4.8, tsx 4.22.0 | Apache-2.0 / MIT |
| **Database Tooling** | drizzle-kit 0.31.10 | MIT |
| **Dev Utilities** | chokidar 4.0.3, picocolors, nanoid 3.3.12, deepmerge, cookie 0.7.2 | MIT / ISC |
| **Type Definitions** | @types/bcryptjs, @types/cookie, @types/d3-force, @types/dompurify, @types/ssh2-sftp-client, @types/ssh2, @types/jsdom 28.0.3 | MIT |
| **Test DOM** (since 2026-10-15) | 40 packages: jsdom 29.1.1 and @types/jsdom 28.0.3, and what each brings | MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, CC0-1.0 (section 9) |

## 6. Security Audit

```
npm audit
```

**Result: ✅ No known vulnerabilities detected across all direct and transitive dependencies.**

All 15 advisories identified in the pre-update scan have been resolved:

| Advisory | Resolution |
|---|---|
| vite path traversal / WebSocket file read / fs.deny bypass (3 high) | Updated vite 7.3.1 → 8.0.13 |
| @sveltejs/kit redirect DoS / BODY_SIZE_LIMIT bypass (high) | Updated @sveltejs/kit 2.50.2 → 2.60.1 |
| svelte SSR XSS / DOM clobbering / ReDoS (3 moderate) | Updated svelte 5.54.0 → 5.56.4 |
| devalue sparse array DoS (high) | Updated devalue 5.6.4 → 5.1.1 (via kit) |
| dompurify FORBID_TAGS bypass / prototype pollution (2 moderate) | Updated dompurify 3.3.3 → 3.4.3 |
| nodemailer SMTP CRLF injection (moderate) | Updated nodemailer 8.0.4 → 8.0.7 |
| fast-xml-builder attribute quote bypass (high) | Resolved via @aws-sdk/xml-builder update |
| fast-xml-parser XML injection (moderate) | Resolved via @aws-sdk update |
| postcss XSS (moderate) | Updated postcss 8.5.8 → 8.5.14 |
| cookie out-of-bounds chars (low) | Overridden cookie 0.6.0 → 0.7.2 |
| esbuild dev server request forgery (moderate) | Overridden esbuild 0.18.20 → 0.25.12 |

## 7. Supply Chain Hygiene

**Scope Management:** The Dockerfile demonstrates excellent dependency hygiene. The multi-stage build runs `npm ci --omit=dev` after building, ensuring all 73 dev-only packages (build tools, type checkers, CSS processors) are pruned from the production image. Only the 237 runtime packages ship in the final container.

**Standardisation:** The development team has chosen highly standardised, well-maintained community packages: Svelte/SvelteKit (Vercel-backed), Drizzle ORM (active open-source project), better-sqlite3 (widely adopted native binding), and official AWS/Azure/Google SDKs for cloud integrations.

**Framework Alignment:** All SvelteKit packages are aligned to the v2.x/5.x release train. All AWS SDK packages are on the v3.972+ release line. Azure packages are consistently on v1.x/4.x/5.x. The recent migration to Vite 8 with `@sveltejs/vite-plugin-svelte@7` demonstrates proactive framework currency.

**Native Dependencies:** `better-sqlite3` requires native compilation (C++ N-API addon). The Dockerfile correctly installs `libsqlite3-0` at runtime. `ssh2` includes optional native crypto acceleration via `cpu-features`. Both use `prebuild-install` for prebuilt binary downloads, minimising build-time compilation.

**Security Posture:** The application implements defence-in-depth with security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection), CSRF protection via SvelteKit's ORIGIN checking, rate limiting on API endpoints (60 req/min), and bcrypt password hashing.

**Dependency Overrides:** Three npm `overrides` are configured in `package.json` to address upstream lag in transitive dependencies:

- `@sveltejs/kit → cookie: ^0.7.2` — SvelteKit still pins `cookie@^0.6.0`; the override forces the patched version.
- `@esbuild-kit/core-utils → esbuild: ^0.25.0` — `drizzle-kit` uses a deprecated `@esbuild-kit` chain with an old esbuild; the override forces the patched version.
- `qs: 6.16.0` (since 2026-10-18, card 2227) — `googleapis-common` 8.0.x asks for `qs@^6.7.0`, which a fresh resolution would answer with 6.16.1, four days old on the day; the override holds it at 6.16.0, past the three advisories `npm audit` listed against 6.15.x (section 10).

These overrides are safe because the packages maintain backwards-compatible APIs across these minor version ranges.

## 8. Conclusion

DumpFire is a well-architected SvelteKit 5 self-hosted Kanban application with a comprehensive feature set including multi-provider cloud backups, real-time SSE sync, PDF report generation, and role-based access control. Its open-source footprint is **excellent**, relying almost entirely on permissive **MIT (217 packages)** and **Apache-2.0 (64 packages)** licences.

With zero copyleft-licensed components in the production build, all dual-licensed packages resolvable to permissive terms, zero known vulnerabilities across 310 dependencies, and a clean Dockerfile build pipeline that properly separates dev and production dependencies, the application's legal and licensing posture is **fully compliant and ready for enterprise deployment**.

## 9. Changes on 2026-10-15

Cards 2202 (one Markdown renderer) and 2203 (the font served by DumpFire) changed what the
application is built from. Nothing was removed and no production package changed version.

**`jsdom` 29.1.1 and `@types/jsdom` 28.0.3, development dependencies** (`^29.1.1`,
`^28.0.3`, both MIT). They are used by `tests/markdown.test.ts` alone, which hands
DOMPurify a jsdom window: DOMPurify needs a DOM, and jsdom is the one its own documentation
names for use outside a browser. They are installed in the image's build stage, which runs
the tests, and pruned with every other development dependency by `npm ci --omit=dev`, so
none reaches the production image. **29.1.1, not the current 30.x:** `.npmrc` sets
`engine-strict=true`, and jsdom 30 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`; the
workstation that built this runs Node 22.18.0, and 29.1.1 (2026-04-30) is the newest whose
engines (`^20.19.0 || ^22.13.0 || >=24.0.0`) accept it. `@types/jsdom` has no 29.x; 28.0.3
is the newest before 30.0.0. Revisit when Node is at least 22.22.2.

The lock gained 40 packages, every one `dev: true`; nothing already in it changed or went.
Their licences:

| Licence | Packages | Risk |
|---|---|---|
| MIT | 31 (jsdom, @types/jsdom, @types/tough-cookie, parse5, undici, whatwg-url, tr46, css-tree, tldts and the rest) | ✅ Very Low |
| MIT-0 | 2 (@csstools/color-helpers, @csstools/css-syntax-patches-for-csstree) | ✅ Very Low |
| BSD-2-Clause | 2 (entities, webidl-conversions) | ✅ Very Low |
| BSD-3-Clause | 1 (tough-cookie) | ✅ Very Low |
| ISC | 1 (saxes) | ✅ Very Low |
| Apache-2.0 | 1 (xml-name-validator) | ✅ Very Low |
| BlueOak-1.0.0 | 1 (lru-cache 11.5.3) | ✅ Very Low: permissive, no copyleft |
| CC0-1.0 | 1 (mdn-data) | ✅ Very Low: public domain dedication |
| **Total** | **40, all dev-only** | |

No copyleft licence came in, and none of them ships.

**`dompurify` raised to 3.4.17.** The range in `package.json` became `^3.4.3` (it was
`^3.3.3`), so that a fresh resolution can no longer pick the release before the
`FORBID_TAGS` fix of section 6, on which the renderer relies; the lock already held 3.4.3.
Then, on the review of the same work, it was raised with npm to 3.4.17, the newest 3.4
release that day: the range is `^3.4.17`, and the lock's `dompurify` entry and its root
range are the only lines of the lock that changed (3.4.17 needs no package 3.4.3 did not).
`tests/markdown.test.ts` holds both files at 3.4.17 or later, and every rule of the
renderer passed unchanged across the upgrade.

**The Inter font, bundled.** Seven `woff2` files of Inter 4.001 (OFL-1.1), with their
licence at `/licences/inter-OFL.txt`: see the row under section 4. The SIL Open Font License
allows the font to be bundled and redistributed with software, subset or converted, if each
copy carries the copyright notice and the licence and the font is not sold on its own. It
binds the font, not the software it is bundled with, and places nothing on DumpFire's own
code. Every page now loads it from DumpFire, and no page asks Google, or any other site, for
anything.

**`npm audit`, 2026-10-15.** Before the raise, ten advisories, none from the packages added:
1 low, 3 moderate, 6 high, in `@sveltejs/kit`, `devalue`, `dompurify`, `esbuild`, `nanoid`,
`nodemailer`, `postcss`, `qs`, `source-map-js` and `vite`, each with a fix available. For
`dompurify` it listed eleven advisories for releases up to 3.4.15. They concern `IN_PLACE`
sanitising, `setConfig()` and `clearConfig()`, a hook that changes `data.allowedTags` or
`data.allowedAttributes`, `SAFE_FOR_TEMPLATES`, Trusted Types and
`CUSTOM_ELEMENT_HANDLING`. The renderer uses none of them: it calls `sanitize()` on its own
instance with `RETURN_DOM_FRAGMENT`, and its one hook sets only `keepAttr` and `attrValue`.
After the raise to 3.4.17, `npm audit` lists nine, 1 low, 2 moderate and 6 high, none of
them in `dompurify`: the other nine packages above, as before.

## 10. Changes on 2026-10-18

Card 2227 (nodemailer's advisories), built with card 2189 (mail over a checked, encrypted
connection), whose rework of `src/lib/server/email.ts` it shares.

**`nodemailer` 8.0.7 → 10.1.1** (`package.json` `^8.0.4` → `10.1.1`, pinned exactly; MIT-0 as
before; no dependencies). 10.1.1 was published on 2026-10-14 and is the first release card
2227 names as fixed. The build first took 10.1.6, the newest on `npm view`, published at
12:55 UTC on 2026-10-18, the day of the build and the fourth release that day (10.1.3 at
10:40); it was replaced with 10.1.1, which had been out four days, so that a release only
hours old does not go into the image. `npm audit`'s range for every advisory listed ends at
10.0.5, so 10.1.1 is past all of them. Pinned without a caret, so that a fresh resolution
cannot take a newer release unread. The lock's `node_modules/nodemailer` is 10.1.1, integrity
`sha512-pbqZRoeYUO+1E8TJ/11WeY4D2EVujj1hsYjz3qff/vUFDtGnmi7p3iqzTFslYOfQ6PnjVcWxx/CIUSHCSrO/QA==`,
`engines.node` `>=20.0.0`: the image is `node:22-slim`.

**`@types/nodemailer` 8.0.0 removed.** nodemailer 10 is written in TypeScript and ships its
own declarations (`dist/esm/nodemailer.d.ts`), which TypeScript takes through the package's
`exports`; there is no `@types/nodemailer` for 10. With it gone, `npm run check` gives 0
errors and 0 warnings, and `email.ts` no longer needs the `as any` it had on the transport's
options.

**Breaking changes read** (nodemailer's `CHANGELOG.md`, 8.0.8 to 10.1.1):

- **9.0.0**: HTTPS requests made while fetching remote content (attachment URLs, OAuth2
  token endpoints, an HTTP proxy) check the server's certificate by default. DumpFire uses
  none of them: every attachment is a `Buffer`, there is no OAuth2 transport and no proxy.
- **10.0.0**: Node.js 20 or newer; rewritten in TypeScript with ESM and CommonJS builds.
  `import nodemailer from 'nodemailer'` takes the ESM build's default export, an object with
  `createTransport`, so the tests' spy on it still stands in for every mail.
- **Not marked breaking, read for card 2189**: 9.0.3 and 10.0.12 harden the STARTTLS upgrade
  and honour `requireTLS`; 10.1.0 ends a session on any `421` and counts the wait for the
  greeting against `connectionTimeout`; 10.1.1 strips credentials on a cross-origin redirect
  while fetching (unused here). nodemailer 10's SMTP connection reads no `family` option, so
  `createTransporter`'s `family: 4` ("force IPv4") was taken out: nodemailer looks up the
  host's IPv4 and IPv6 addresses itself and tries them in turn
  ([Connection Handling](notifications-email.md#connection-handling)).

Every mail goes through three functions in `email.ts`, and the suite sends through all three
on each port and setting. Outside the suite, with the real nodemailer against a stand-in relay
on `127.0.0.1` and a throwaway certificate, a missing STARTTLS came back `ETLS` and a
certificate refused `ESOCKET`, in no refused case did the password cross, and
`NODE_EXTRA_CA_CERTS` was honoured. That run was made with 10.1.6, the release first
installed, and was not repeated with 10.1.1; the suite was.

**`npm audit --omit=dev`, before** (nodemailer 8.0.7):

```
nodemailer  <=10.0.5
Severity: high
(11 advisories: GHSA-268h-hp4c-crq3 List-* header injection; GHSA-wqvq-jvpq-h66f,
GHSA-p6gq-j5cr-w38f and GHSA-8m3c-c648-2xjj file and URL access bypasses; GHSA-2x7j-588g-ccc2,
GHSA-v53p-9fqp-m79j and GHSA-8vvx-rff5-p5rq address-parser denial of service;
GHSA-wmmp-3585-3rmp and GHSA-cc9r-2j5m-2m83 recipient-domain bypasses; GHSA-6vj9-mwq6-2f5v TLS
servername reused across transports; GHSA-r7g4-qg5f-qqm2 OAuth2 token fetch unchecked)
fix available via `npm audit fix --force`
3 vulnerabilities (1 moderate, 2 high)
```

**After** (nodemailer 10.1.1, run 2026-10-18):

```
devalue  <=5.9.2
Severity: high
qs  2.2.5 - 6.15.3
Severity: moderate
2 vulnerabilities (1 moderate, 1 high)
```

No `nodemailer` entry. `devalue` and `qs` were the second part of the card, below.

### SvelteKit, Svelte, devalue and qs (card 2227, second part)

The rest of card 2227: `devalue` (high, through `@sveltejs/kit` and `svelte`), `qs` (moderate,
through `googleapis` → `googleapis-common`), and the unauthenticated denial of service in
SvelteKit's reading of the `Accept` header that the card names, fixed after 2.70.1. Every
release taken was published at least seven days before the build (2026-10-18), checked with
`npm view <package> time --json`; the transitive releases the install brought in are
1.0.13 of `@sveltejs/acorn-typescript` (2026-08-13), `acorn` 8.19.0 (2026-10-05), `esrap`
2.4.0 (2026-09-26), `es-object-atoms` 1.1.2 (2026-05-22), `side-channel` 1.1.1 (2026-06-08)
and, new, `@rollup/plugin-replace` 6.0.3 (2025-10-29, dev, the adapter's).

| Package | Before → after | Published | `package.json` | Lock integrity |
|---|---|---|---|---|
| `@sveltejs/kit` | 2.60.1 → 2.70.3 | 2026-08-18 | `^2.60.1` → `^2.70.3` (dev: bundled at build) | `sha512-UDvEYuZqAMbfB/oXIoqKvbKcb7YczK5zYrzmsGV1zRJk03jntwp8dXiYoIJotxAndsKvcPFtx9H1GRSKFdSHgg==` |
| `svelte` | 5.55.7 → 5.57.2 | 2026-10-06 | `^5.55.0` → `^5.57.2` | `sha512-1YiPCAXT0Ct6g1vOMmSLa0Nsc3QRMvtDF32ihgglGVrugIuIK38RyDiFNXVDhtQ81TJjSO57NdMw6DyYLqSGDQ==` |
| `@sveltejs/adapter-node` | 5.5.4 → 5.5.7 | 2026-06-24 | `^5.5.4` → `^5.5.7` (dev) | `sha512-uOfc9eVlI3A37RRSaKcgrheBYPrfJwC9VMqDp8x/O6tlKdcLLvHThSWD0KNIbjQ/d+7bwLGx3vx6aowAcRfd2g==` |
| `devalue` | 5.8.1 → 5.9.4 | 2026-09-18 | none: what kit (`^5.8.1`) and svelte (`^5.9.2`) resolve to | `sha512-sPAT4pztbu6586/hrhOnMKS17IJrvg12mXiSPSS3W5qDeN2RGgvZ0diZCm31dBbnevfVmujNO3IM2wrS4Y2Rhg==` |
| `qs` | 6.15.1 → 6.16.0 | 2026-08-29 | `overrides`: `"qs": "6.16.0"` | `sha512-h6fhOIaRrID2CbEY2fqs+7t+UXZo+MLAnU5gRIq85uFtdiUPCdsApMlHhXogKVM4HM2DVbIjGNTTYH2OcmP1vA==` |

- **SvelteKit stays on 2.x** and the adapter on 5.x: 3.0.0 came out on 2026-10-01 and 3.1.0 on
  2026-10-14, a major version each for another card. 2.70.3 is the newest 2.x.
- **devalue needed no override.** Both ranges resolve to 5.9.4, past every advisory
  `npm audit` listed (its range ends at 5.9.2; 5.9.3 holds the fixes and 5.9.4 adds only a
  tree-shaking annotation), and a month old. devalue 6.x is not asked for by either.
- **qs by an override, and not by moving googleapis.** No `googleapis-common` 8.x asks for
  more than `qs@^6.7.0`, so no update within googleapis 171 moves `qs`; `npm update` would
  have taken 6.16.1, published on 2026-10-14, four days before the build. googleapis's
  major is unchanged. The override is exact, so a fresh resolution cannot move it unread.
  That cuts both ways: it also blocks every later `qs` fix, which `npm update` and
  `npm audit fix` will not take while it stands. Revisit it with the next googleapis update.
- The overrides already there are kept: kit's `cookie` (`^0.7.2`, still needed: kit 2.70.3
  asks for `cookie@^0.6.0`) and drizzle-kit's `esbuild`.

**Changelogs read** (SvelteKit and adapter-node from the `version-2` branch's
`CHANGELOG.md`, svelte's, devalue's, and `qs`'s shipped `CHANGELOG.md`), for what DumpFire
uses:

- **SvelteKit 2.61.0** removes `.run()` from remote queries (DumpFire has no remote
  functions), and **prefers the default error page when it cannot decode a URL's path**:
  it now calls `handle` for such an address, with no route, where up to 2.60 it answered
  `400` "Malformed URI" before calling it. `routedPath()` in `src/hooks.server.ts` decoded
  the path with `decodeURI`, which threw: every malformed address became a `500`. Fixed in
  the gate (below).
- **SvelteKit 2.70.0** makes the cross-site form check (`csrf.checkOrigin`) in any build,
  and keys it on `__SVELTEKIT_DEV__` and not `DEV`; under vitest the check is now made, as
  in a built server. Nothing changes in production, which always made it. Tests that post a
  form or `text/plain` now send `origin: 'http://localhost'`, as a browser does.
- **SvelteKit 2.70.2** is the `Accept` fix ("prevent quadratic backtracking in `Accept`
  header content negotiation"); 2.70.3 stops `$app/state` being read eagerly at module
  start. Measured on SvelteKit's own `negotiate`, with an `Accept` of 15,000 `a`s and a
  comma: 79.6 ms in 2.60.1, 0.1 ms in 2.70.3; with 50,000, 850 ms and 0.0 ms. **The gate had
  the same fault of its own:** `preferredType()` in `src/lib/server/gate-answers.ts` is
  SvelteKit's `negotiate` copied line for line, so that the gate chooses between JSON and a
  page as SvelteKit does, and it is asked on every request before anybody is identified.
  The upgrade alone left it quadratic (about 90 ms for 15,000 letters on `/api/boards` in
  the built server, 0.9 s for 50,000 under vitest); its pattern is now anchored as 2.70.2's
  is, and `tests/gate.test.ts` holds it to SvelteKit's answers and to a hostile header.
- **Read and unaffected:** `$app/state` (`updated`, `page`), `goto(…, { replaceState })`
  and shallow `replaceState`, `version.pollInterval` (card 2167's update bar), `kit.csp`
  with `mode: 'auto'` and `%sveltekit.nonce%` (card 2162: 2.66.0 only adds `ws:`/`wss:`
  and `trusted-types-eval` sources), `json`/`error`/`text`, hooks (2.61.0 only drops a build
  warning), `MAX_COOKIE_SIZE` aligned with RFC 6265bis (2.69.3), and 2.66.0's blur of the
  focused element before a navigation updates the page.
- **adapter-node 5.5.5 to 5.5.7**: 5.5.5 builds the handler alongside the application
  instead of with copies of its own, so a request is now made by SvelteKit's
  `getRequest` (`@sveltejs/kit/node`): a body with no `Content-Length` is held to
  `BODY_SIZE_LIMIT` (it was held to nothing), and there is one `SvelteKitError` class in the
  built server, not two. `parse_as_bytes` moved to `files/utils.js`, unchanged. 5.5.6
  ensures `ENV_PREFIX` is defined; 5.5.7 adds `X-Accel-Buffering: no` to event streams and
  removes a stale socket file at start. The variables DumpFire sets (`BODY_SIZE_LIMIT`,
  `PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER`, `ORIGIN`, `PORT`) read as before.
  `tests/body-limits.test.ts`, which reads these rules from the source, was pointed at
  the new places and states the new rule; the gate's own count of a chunked body against
  its route's limit is unchanged and still needed, the route limits being smaller.
- **svelte 5.55.8 to 5.57.2**: patch and minor releases, nothing marked breaking. Runes,
  `$effect` and `untrack` as used here are unaffected; among the fixes are effect teardowns
  given the value from before the first write in a flush (5.56.10) and untracked derived
  reads no longer retaining disconnected dependencies (5.57.2). New compile-time errors
  (a second `{:else}`, a snippet parameter redeclared, `let:` beside a `children` snippet)
  are found by `npm run check`, which gives 0 errors and 0 warnings.
- **devalue 5.8.2 to 5.9.4** and **qs 6.15.2 to 6.16.0**: fixes and additive options only.
  DumpFire calls neither directly.

**What broke, and how it was fixed.** After the upgrade, `npx vitest run` had 10 failures
in `tests/gate.test.ts` and `tests/access-every-route.test.ts`, and
`tests/body-limits.test.ts` failed to collect; once it did, 9 more failed there. Each came
from a change above. `tests/error-shape.test.ts` then asked for the gate's new plain-text
`400` to be put on its allow-list, with the reason, as SvelteKit's own words:

- The malformed-address `500`: `routedPath()` returns null where the address cannot be
  decoded, and `handle` answers it first, `400` `Malformed URI` in plain text, word for word
  what SvelteKit answered before, with nothing logged and now with the five security
  headers (`secured()`); `handleError` falls back to the address as sent.
- The cross-site check now made under vitest: the tests that post a form as a page does
  send the page's `Origin`.
- adapter-node's moved source: the test that reads `parse_as_bytes` and `get_raw_body`
  reads them from `files/utils.js` and SvelteKit's `getRequest`.
- And, found in the build check rather than by a failing test, the gate's copy of the
  quadratic `Accept` pattern (above), anchored.

The suite is then 61 files and 5,574 tests, all passing (5,572 before: one test for the
adapter's use of `getRequest`, one for a hostile `Accept` header), and `npm run check`
gives 0 errors and 0 warnings.

**`npm audit --omit=dev`, before** (2026-10-18, after the nodemailer part):

```
devalue  <=5.9.2
Severity: high
(8 advisories: GHSA-9rgm-9g3h-6x36 DoS via malformed input; GHSA-j22f-vq7h-c4qm shared memory
serialised; GHSA-hx4r-w6wj-j8fg, GHSA-mcm9-63f2-9j32 and GHSA-wf3x-273g-mvxv uneval CPU and
memory amplification; GHSA-x5rw-q4pp-hg5g unhandled rejection in stringifyAsync;
GHSA-4q55-j62x-fr9h __proto__ check bypass; GHSA-r9w8-h9r3-54w4 typed-array reviver bypass)
qs  2.2.5 - 6.15.3
Severity: moderate
(3 advisories: GHSA-q8mj-m7cp-5q26 stringify crash; GHSA-x5fp-wj9c-mxmx arrayLimit bypass;
GHSA-4mjr-xmp4-gh2g isBuffer DoS)
2 vulnerabilities (1 moderate, 1 high)
```

**After:**

```
found 0 vulnerabilities
```

The full `npm audit`, dev packages included, lists five, none in what the image ships and
none moved by this card: `esbuild` 0.27.3–0.28.0 (low, the dev server on Windows), `nanoid`
≤3.3.17, `postcss` ≤8.5.22, `source-map-js` 1.0.0–1.2.1 and `vite` 8.0.0–8.0.15 (high), all
build or test tooling.

**Checked in a production build**, on a scratch database and never `dumpfire.db`
(`DB_PATH` a new file in a temporary folder, `SCHEDULERS=off`): `npm run build` passed
(its `prebuild` runs the schema check and `npm run check`, 0 errors, 0 warnings), and
`node build` on port 4399 with `ORIGIN=http://localhost:4399` started, applied every
migration to the empty database and listened. `/login` answered `303` to `/setup` (no users)
with the security headers; `/setup` answered `200` with a `content-security-policy` whose
`script-src` is `'self' 'nonce-…'`, both inline scripts carrying that nonce, and the start
and app scripts and both stylesheets it names each answered `200`. Hostile `Accept`
headers (15,000 `a`s and a comma, 3,000 `a/a;`, 15,000 `;`, 2,000 `a/a;q=`, 7,000 ` ,`) on
`/setup`, `/api/boards`, `/api/v1/me` and a path that is no route were each answered in
under 100 ms, the slowest `/api/boards` at 92 ms, which is how the gate's own copy of the
pattern was found; one of 50,000 characters is refused `431` by Node itself, whose header
limit is 16 KB, before SvelteKit sees it. The server was stopped by its process id and the
scratch database, with its `-wal` and `-shm`, deleted.

After the gate's pattern was anchored the build and the checks were run again, on a new
scratch database: the same answers for `/login`, `/setup` and its four files; 15,000 `a`s
answered in 27 ms on `/api/boards`, 4 ms on `/setup` and `/api/v1/me`, 10 ms on a path that
is no route; and `/%zz`, sent as it is (`curl --path-as-is`), answered `400` `Malformed URI`
in plain text with the five security headers, and nothing written to the log for it. The
server was stopped by its process id, nothing was left listening on port 4399, and the
database and its `-wal` and `-shm` were deleted.
