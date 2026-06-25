---
title: "SBOM Analysis: DumpFire"
category: "Identity & Security"
version: 1.0
status: As-Built
date: 2026-05-15
tags:
  - sbom
  - licensing
  - compliance
  - open-source
  - audit
  - security
description: "Software Bill of Materials and open-source posture analysis for the DumpFire Kanban board application"
---

# SBOM Analysis: DumpFire

Based on production dependency analysis via `license-checker` and `npm audit` (scanned 2026-05-15, post-update), here is an architectural summary and open-source posture analysis of the DumpFire application.

## 1. Application Summary

DumpFire is a self-hosted, real-time **Kanban board** built for teams on a local network. It is a full-stack **SvelteKit 5** (Runes) web application running on **Node.js 22**, backed by an embedded **SQLite** database. By analysing its dependency tree, we can deduce its core architecture and capabilities:

**UI Framework (SvelteKit 5 + Svelte Runes):** The frontend is a server-rendered SvelteKit application using the Svelte 5 Runes reactivity model. The `@sveltejs/adapter-node` compiles the app into a standalone Node.js server, containerised via a multi-stage Dockerfile. Drag-and-drop Kanban interactions are powered by `svelte-dnd-action`. Rich text rendering uses `marked` (Markdown parser) with `dompurify` for XSS sanitisation.

**Data Layer (SQLite + Drizzle ORM):** All data is stored in a single SQLite file via `better-sqlite3` (a synchronous, native N-API binding). Schema management and queries use `drizzle-orm` with `drizzle-kit` for migration generation. WAL mode is enabled for concurrent read performance.

**Authentication & Security:** User passwords are hashed with `bcryptjs` (BSD-3-Clause, pure JS). Session-based auth with 30-day sliding windows, API key bearer tokens, and rate limiting are implemented in server hooks. Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection) are applied globally.

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
| dompurify | 3.4.3 | (MPL-2.0 OR Apache-2.0) | ✅ Compliant | Dual-licensed. The Apache-2.0 option is selected, which is fully permissive. MPL-2.0 is file-level copyleft but the OR clause allows choosing Apache-2.0 instead. |
| pako | 1.0.11 | (MIT AND Zlib) | ✅ Compliant | Dual-licensed under both MIT and Zlib. Both are maximally permissive. Zlib licence permits use in commercial software without attribution. |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | ✅ Compliant | Triple-licensed. Any of the three options is permissive. MIT is the most common selection. |
| expand-template | 2.0.3 | (MIT OR WTFPL) | ✅ Compliant | Dual-licensed. MIT is the standard selection. WTFPL is maximally permissive. |
| tweetnacl | 0.14.5 | Unlicense | ✅ Compliant | Public domain dedication. No restrictions whatsoever. Used by `ssh2` for cryptographic primitives. |
| png-js | 1.1.0 | MIT* | ✅ Compliant | The asterisk indicates the licence was inferred from the LICENSE file rather than package metadata. Confirmed MIT on GitHub. |
| url-template | 2.0.8 | BSD* | ✅ Compliant | Inferred BSD-3-Clause from the LICENSE file. Used by `googleapis-common`. |
| nodemailer | 8.0.7 | MIT-0 | ✅ Compliant | MIT No Attribution — even more permissive than standard MIT. No attribution requirement. |
| lightningcss | 1.32.0 | MPL-2.0 | ✅ Dev-only | Mozilla Public Licence 2.0 (file-level copyleft). Dev-only CSS build tool, **not bundled** into production. No compliance impact. |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | ✅ Dev-only | Native binary for lightningcss. Same MPL-2.0, same dev-only status. |

## 4. Complete Production Dependency Inventory

The following tables list all 237 production-scoped packages compiled into the production application, grouped by functional area.

### UI Framework — SvelteKit & Svelte (MIT)

| Package | Version | Integration |
|---|---|---|
| svelte | 5.56.4 | Bundled — reactive UI framework |
| @sveltejs/acorn-typescript | 1.0.9 | Bundled — TypeScript parser for Svelte |
| acorn | 8.16.0 | Bundled — JavaScript parser |
| esrap | 2.2.4 | Bundled — code generation |
| esm-env | 1.2.2 | Bundled — environment detection |
| locate-character | 3.0.0 | Bundled — source location |
| zimmerframe | 1.1.4 | Bundled — AST walker |
| magic-string | 0.30.21 | Bundled — string manipulation |
| is-reference | 3.0.3 | Bundled — AST reference detection |
| aria-query | 5.3.1 | Bundled — a11y role mapping (Apache-2.0) |
| axobject-query | 4.1.0 | Bundled — a11y object mapping (Apache-2.0) |
| devalue | 5.1.1 | Bundled — data serialisation |
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
| nodemailer | 8.0.7 | MIT-0 | Linked — SMTP email transport |

### Markdown & Sanitisation (MIT + MPL-2.0/Apache-2.0)

| Package | Version | Licence | Integration |
|---|---|---|---|
| marked | 18.0.3 | MIT | Bundled — Markdown to HTML parser |
| dompurify | 3.4.3 | (MPL-2.0 OR Apache-2.0) | Bundled — HTML sanitiser |

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
| qs | 6.15.0 | BSD-3-Clause | Linked — query string parsing |
| bowser | 2.14.1 | MIT | Linked — browser detection |
| buffer | 5.7.1 | MIT | Linked — Buffer polyfill |
| readable-stream | 3.6.2 | MIT | Linked — streams polyfill |

### Type Definitions (MIT)

| Package | Version | Integration |
|---|---|---|
| @types/better-sqlite3 | 7.6.13 | Types — SQLite bindings |
| @types/node | 25.8.0 | Types — Node.js |
| @types/estree | 1.0.9 | Types — ESTree AST |
| @types/nodemailer | 8.0.0 | Types — Nodemailer |
| @types/pdfkit | 0.17.6 | Types — PDFKit |
| @types/trusted-types | 2.0.7 | Types — Trusted Types |
| @nodable/entities | 2.1.0 | Types — XML entity parsing |
| undici-types | 7.26.0 | Types — Undici HTTP |

## 5. Dev-Only Dependencies (73 packages)

The following packages are used exclusively for development and build tooling. They are **not bundled** into the production Docker image (pruned via `npm ci --omit=dev` in the Dockerfile build stage):

| Category | Key Packages | Licence |
|---|---|---|
| **SvelteKit Tooling** | @sveltejs/kit 2.60.1, @sveltejs/adapter-node 5.5.4, @sveltejs/adapter-auto 7.0.1, @sveltejs/vite-plugin-svelte 7.1.2 | MIT |
| **Build System** | vite 8.0.13, rollup 4.60.4, rolldown 1.0.1, esbuild (0.25.12, 0.28.0), @rollup/plugin-* | MIT |
| **CSS Processing** | lightningcss 1.32.0, postcss 8.5.14 | MPL-2.0 / MIT |
| **TypeScript** | typescript 5.9.3, svelte-check 4.4.8, tsx 4.22.0 | Apache-2.0 / MIT |
| **Database Tooling** | drizzle-kit 0.31.10 | MIT |
| **Dev Utilities** | chokidar 4.0.3, picocolors, nanoid 3.3.12, deepmerge, cookie 0.7.2 | MIT / ISC |
| **Type Definitions** | @types/bcryptjs, @types/cookie, @types/d3-force, @types/dompurify, @types/ssh2-sftp-client, @types/ssh2 | MIT |

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

**Dependency Overrides:** Two npm `overrides` are configured in `package.json` to address upstream lag in transitive dependencies:

- `@sveltejs/kit → cookie: ^0.7.2` — SvelteKit still pins `cookie@^0.6.0`; the override forces the patched version.
- `@esbuild-kit/core-utils → esbuild: ^0.25.0` — `drizzle-kit` uses a deprecated `@esbuild-kit` chain with an old esbuild; the override forces the patched version.

These overrides are safe because both packages maintain backwards-compatible APIs across these minor version ranges.

## 8. Conclusion

DumpFire is a well-architected SvelteKit 5 self-hosted Kanban application with a comprehensive feature set including multi-provider cloud backups, real-time SSE sync, PDF report generation, and role-based access control. Its open-source footprint is **excellent**, relying almost entirely on permissive **MIT (217 packages)** and **Apache-2.0 (64 packages)** licences.

With zero copyleft-licensed components in the production build, all dual-licensed packages resolvable to permissive terms, zero known vulnerabilities across 310 dependencies, and a clean Dockerfile build pipeline that properly separates dev and production dependencies, the application's legal and licensing posture is **fully compliant and ready for enterprise deployment**.
