---
title: "DumpFire Deployment Guide"
category: Deployment
version: 1.82
status: As-Built
date: 2026-10-21
tags:
  - docker
  - deployment
  - configuration
  - production
  - environment
  - migrations
  - upgrade
  - rollback
  - backup
  - uploads
  - attachments
  - testing
  - verify
  - superadmin
  - body-size-limit
  - nginx
  - client-address
  - rate-limiting
  - security-headers
  - content-security-policy
  - csp-mode
  - fonts
  - sessions
  - timestamps
  - indexes
  - attachment-sweep
  - webhooks
  - webhook-allow-list
  - board-page
  - card-window
description: "Docker deployment, the update in which the board page and its card window apply each change and read only their board again, with its hands-on checks, WEBHOOK_ALLOW_INSIDE and where a webhook may send, the update that brings migration 0056 and the webhook rules with the checks to run before it, running the test suite before an image is built, environment variables, volume mounts, attachment files and their backup, start-up and migrations, the superadmin and the way back to it from the host, upload size limits at the proxy and in the server, the caller's address behind a proxy, the security headers the proxy is to add and the policy it must not, updating and going back, the update that brings the Content-Security-Policy and its report-only first deploy, the update that brings migration 0053, one timestamp form and the attachment file sweep, with the checks to run before it, the read-only queries for notices on cards moved before card 2256, and production configuration for DumpFire"
---

# DumpFire Deployment Guide

DumpFire is deployed as a single Docker container running Node.js 22 with an embedded SQLite database. No external database server is required.

## Deployment Architecture

```mermaid
flowchart LR
    Users["👤 Users"]
    Proxy["🔒 Reverse Proxy\nNginx / Caddy / Traefik"]

    subgraph Host["Docker Host"]
        subgraph Container["DumpFire Container"]
            Node["⚙️ Node.js 22\nSvelteKit Server"]
            SQLite[("🗄️ SQLite DB")]
            Uploads["📎 Uploads"]
        end
        Volume["💾 Docker Volume\n/app/data"]
    end

    SMTP["📧 SMTP Server"]
    Backup["💾 Backup Destination\nSFTP / S3 / GDrive"]

    Users --> Proxy
    Proxy -->|"Port 3000"| Node
    Node --> SQLite
    Node --> Uploads
    SQLite -.-> Volume
    Uploads -.-> Volume
    Node -.->|"Email"| SMTP
    Node -.->|"Scheduled"| Backup
```

## Docker Build

The Dockerfile uses a two-stage build for minimal image size:

```mermaid
flowchart TD
    subgraph Stage1["Stage 1: Builder"]
        S1A["npm ci"] --> S1V["npm run verify\n(the test suite)"]
        S1V --> S1B["npm run build"]
        S1B --> S1C["npm ci --omit=dev"]
    end

    subgraph Stage2["Stage 2: Production"]
        S2A["Install libsqlite3-0"]
        S2B["Copy build/"]
        S2C["Copy node_modules/"]
        S2D["Copy drizzle/"]
        S2E["node build"]
        S2A --> S2B --> S2C --> S2D --> S2E
    end

    Stage1 -->|"Copy artifacts"| Stage2
```

### Build Command

```bash
docker build -t dumpfire:latest .
```

The build asks for no particular builder. The `Dockerfile` has no `# syntax=` line and no flag on any step: its test step is a plain `RUN npm run verify`, which the classic builder and BuildKit both know. It has been built under BuildKit only (the default builder since Docker 23, and the one Docker Desktop 29.2.1 uses); under the classic builder it has not been tried.

### Run the Tests Before You Build

> ✅ **The image build runs the test suite, and stops if a test fails.** The builder stage of the `Dockerfile` runs `npm run verify` after the source is copied in and before `npm run build`. A failing test ends `docker build` at that step with exit status 1 and no image is made, so an image cannot be built from a tree whose tests fail. `npm run build` then makes its own check, of the expected schema (see [Changing the Schema](#changing-the-schema)).

Running the suite by hand first is still the quick way to find out. It takes under a minute (43 seconds on the workstation on 2026-10-15), where a build that fails has already cost a `git pull` and an `npm ci` on the Docker host. Run it where the repository is checked out with its dependencies installed (`npm ci`), on the commit that is going to be deployed and before that commit is pushed to where the image is built:

```bash
npm run verify
```

- **What it runs.** The whole suite, once: every test file listed in `tests/harness.test.ts`. It is `vitest run --allowOnly=false`: `npm test` with one flag more, so that a test left marked `.only`, which would run alone and skip every other test in its file, fails the run instead of passing it.
- **What it touches.** A database in memory and a folder under the operating system's temp directory. It refuses to run against any other database, starts no server and opens no port. It delivers no mail and no webhook, and attempts none: `tests/setup.ts` refuses every `fetch` and every DNS lookup, and fails the test that attempted one, by the address. Until 2026-10-13 that was not so. Five tests let the application try to mail `smtp.example.test` and to call `https://hooks.example.test/...`: seven DNS lookups and four `fetch` calls in a run, each for a name that resolves nowhere, so nothing was delivered, and each a question put to the machine's resolver. It is safe on a machine that holds a real `dumpfire.db`. See [Testing](testing.md).
- **A pass** ends with `Test Files  N passed (N)`, every test file having passed, and exit status 0. The line under it counts the tests that `passed`, and any marked `expected fail` or `skipped`. Those two are not failures: a test marked as expected to fail records a fault that is known and not yet fixed. When none is expected to fail and none is skipped, as on 2026-10-15, the line counts `passed` alone. See [Testing](testing.md#known-faults-the-suite-records).
- **A failure** ends with `Test Files  N failed`, names each failing test with its file, and exits with status 1. Do not push the commit: the image build would stop on the same test.
- **`[ERROR]` lines in a run that passes** are not failures. They are the application's own log of something that went wrong during a test, which the test caused on purpose. The two summary lines and the exit status are what say whether the run passed.

```mermaid
flowchart TD
    Commit["The commit to deploy,<br/>on a workstation"] --> Verify["npm run verify<br/>(the quick check)"]
    Verify --> Pass{"Test Files: all passed?<br/>Exit status 0?"}
    Pass -->|"No"| Stop["Do not push.<br/>Read the failing tests, fix, run it again"]
    Stop --> Verify
    Pass -->|"Yes"| Push["Push the commit, then git pull on the Docker host"]
    Push --> Build["docker build, or docker compose build"]
    Build --> InImage{"RUN npm run verify:<br/>did every test pass<br/>inside the image?"}
    InImage -->|"No"| TestsFail["The build stops at that step.<br/>No image. Nothing is deployed"]
    TestsFail --> Stop
    InImage -->|"Yes"| Prebuild{"prebuild: is the expected<br/>schema up to date, and does<br/>the type check pass?"}
    Prebuild -->|"No"| BuildFails["The build stops. No image"]
    Prebuild -->|"Yes"| Image["Image"]
    Image --> Rehearse["Rehearse it against a copy,<br/>if it brings a migration"]
    Rehearse --> Deploy["Replace the container"]
```

#### The Suite Inside the Image Build

`docker build` runs the same files with the same command, on the image's own Linux and Node (`node:22-slim`) instead of the workstation's. The step is a plain `RUN npm run verify`. It needs no network and no special builder, because the tests refuse the network themselves: `tests/setup.ts` refuses every `fetch` and every DNS lookup, and fails the test that attempted one. Docker does not cut the step off from the network as well. For part of 2026-10-13 the `Dockerfile` said `RUN --network=none`, under a `# syntax=docker/dockerfile:1` line; that was never built, and was taken out, because the flag works only under BuildKit and the Docker version of the production host is not known. A pass ends the step with the same two lines as on the workstation, every test file passed and every test counted. With the suite as it was on 2026-10-18, where none is expected to fail and none is skipped, they read:

```
Test Files  61 passed (61)
     Tests  5572 passed (5572)
```

- **On a builder with fewer than three CPUs, two tests are skipped**, and the second line reads `5570 passed | 2 skipped (5572)`, which is a pass. They are the two tests of `tests/password-checks.test.ts` that time the server's thread while real worker threads check passwords (card 2191): the thread stays free while six checks are made at once, and an unrelated request is answered meanwhile. Each runs two threads, the first against a bound of half of one check timed in the same run (card 2274) and the second against 100 ms, and with fewer than three CPUs the two threads share them with the test's own, which could fail the build for a fault that is not there. Before a build, `docker info --format '{{.NCPU}}'` on the host that builds says how many it has. The other fourteen tests of the file run anywhere.

- **What it adds to a build.** About as long as the suite takes outside Docker on the same machine. The first build with the step, on 2026-10-13, spent 18.5 seconds in it on a 28-core workstation, when the suite was 2220 tests and took 20 seconds on that workstation outside Docker. The second build, later that day on the same workstation, when the suite was 2624 tests and took 28 seconds there, spent 23.7 seconds in the step, of which vitest counted 22.5 as its own. The suite has grown since (43 seconds there on 2026-10-15) and has not been built in Docker at that size. A smaller Docker host will take longer.
- **What it adds to the image.** Nothing. The suite runs in the builder stage, which is thrown away. The production stage is copied from `build/`, `node_modules/` (reinstalled without dev dependencies after the build), `package.json` and `drizzle/` alone. An image built with the step and one built without it from the same tree held the same 27,933 files, apart from the content hashes in the names under `build/` that differ between any two builds, and no `tests/` folder and no vitest. The image of the second build, of the suite as it was then, was listed in the same way and came to the same 27,933: `/app` holds `build/`, `drizzle/`, `node_modules/`, `package.json` and an empty `data/`, with no `tests/`, no `src/`, no database file, and no package the lock file marks as a dev dependency (no vitest, vite, TypeScript, `svelte-check` or `drizzle-kit`). Two names from `devDependencies` in `package.json` are in it all the same, because a production dependency names each as a peer and `npm ci --omit=dev` therefore keeps it: `svelte`, for `svelte-dnd-action`, and `@types/better-sqlite3`, for `drizzle-orm`.
- **What it touches.** Inside the build, a database in memory and `/tmp` in the builder stage. There is no `dumpfire.db` in the build to touch (see below).
- **A test file left out of the commit fails the build.** The build runs the test files that were committed and reached the host, and vitest does not know what is missing: a build without `tests/access-every-route.test.ts` used to pass with `29 passed (29)`. The files are now listed in `tests/harness.test.ts`, and a test there fails, naming the file, when one in the list is not on disk or one on disk is not in the list. A new test file is added to that list in the commit that adds it. See [Testing](testing.md#the-list-of-test-files).
- **A test left marked `.only` fails the build.** `npm run verify` passes `--allowOnly=false`, and the file with the mark fails with `Unexpected .only modifier`.
- **A step shown as `CACHED`** was not run again, because Docker has already run it on exactly these files and it passed. Any change to a file in the build context runs it again.
- **A failure** ends the build with `ERROR: process "/bin/sh -c npm run verify" did not complete successfully: exit code: 1`. The failing tests are named above that line. A test that reached for the network is one of them, on a workstation and in the build alike: `This test reached for the network: ...`, with the address. `npm run build` is not reached and no image is tagged; the container that is running is not affected, because nothing has replaced it.

**What is kept out of the build.** `.dockerignore` keeps these out of the build context, so they never reach Docker, the builder stage or the build cache: any `*.db`, `*.db-shm` and `*.db-wal` file, at the top of the repository and in any folder beneath it (a development `dumpfire.db`, its dated backups, and a copy put in a sub-folder), any `*.backup-temp` and `*.backup-temp-*` file at any depth (the copies `GET /api/admin/export` and a backup make beside the database while they run, `<database>.backup-temp` and `<database>.backup-temp-cleared`), any `*.export-temp` file at any depth (the name an older export used for its copy), `.pre-restore-safety.json` (the copy of the data kept before a restore), the `uploads` folder of attachment files, `.env` and `.env.*`, and the local tooling in `.agent`, `.claude`, `.vscode` and `.git`, along with `.gitignore`, `README.md`, and `node_modules`, `.svelte-kit` and `build`, which the image makes for itself. The database patterns once matched at the top of the repository only, and a database copied into a sub-folder would have been sent; `**/*.db` and its two companions were added on 2026-10-13. The other names are still matched at the top only. The context was listed before each of the two builds of 2026-10-13. Before the first, which was before those patterns were added: 417 files, 5.9 MB. Before the second, with them in place: 418 files, 5,993,090 bytes. None of those names was anywhere in either.

**What has been proved.** The step has been built twice, both times on 2026-10-13 with Docker 29.2.1 on a Windows workstation (Docker Desktop, Linux containers, amd64, BuildKit). The first build was the first time the suite ran on Linux: it passed with the totals it then had (`2200 passed | 19 expected fail | 1 skipped`), `prebuild` and `npm run build` passed after it, and a build with one failing test added inside the builder stage stopped at the step as described.

The second build was of what is described here: the plain `RUN npm run verify`, `--allowOnly=false` in `npm run verify`, the `.dockerignore` patterns for any depth, and the suite at the totals it then had, with the network refused from inside. It ended with exit status 0. The step printed `Test Files  30 passed (30)` and `Tests  2578 passed | 45 expected fail | 1 skipped (2624)`, which are the workstation's totals, and each of the 30 files reported the same number of tests in the build as on the workstation; no test was changed to get there. `prebuild` and `npm run build` passed after it. Two more builds, each with one test added to `tests/docs-format.test.ts` inside the builder stage, stopped at the step with exit status 1 and never reached `npm run build`: one with a test that fails (`Test Files  1 failed | 29 passed (30)`), and one with a test marked `.only` (`Unexpected .only modifier`).

**What has not.** Every one of those builds was made from a Windows working copy, in which 27 source files have CRLF line endings; the Docker host builds from a Linux checkout of a commit, where every file has LF. The first build on the Docker host is therefore the first from such a checkout, and the first on that host's hardware and with its version of Docker, which is not known here. The step asks nothing of that version but a plain `RUN`; the classic builder has not been tried. If a build stops at the step with a failure that names an address, a test is reaching for the network and the guard in `tests/setup.ts` has caught it: fix the test.

When `npm run verify` fails, on a workstation or in the build:

| The output says | It means | Do |
|-----------------|----------|----|
| A test failed with an assertion, in a file under `tests/` | The change broke something the test holds, or changed it on purpose | Fix the code. If the behaviour was changed on purpose, change the test in the same commit and say why. Never skip or delete a test to get an image |
| `Expect test to fail` | A test marked `it.fails` passed: the known fault it records has been put right | Take the mark off that test, or the `fault` off its entry in `tests/access-every-route.test.ts`, in the commit that fixed the fault |
| `routes and methods with no entry in TABLE` | A route or a method was added under `src/routes/api` and nobody has said who may call it | Add its entry to the table in `tests/access-every-route.test.ts`. See [Testing](testing.md#access-for-every-route) |
| `test files in TEST_FILES that are not under tests/` | A test file in the list is not in this tree: it was left out of the commit, or deleted | Commit the file. If it was deleted on purpose, take its name out of `TEST_FILES` in `tests/harness.test.ts` |
| `test files under tests/ that are not in TEST_FILES` | A test file was added and not listed | Add its name to `TEST_FILES` in `tests/harness.test.ts`. See [Testing](testing.md#the-list-of-test-files) |
| `Unexpected .only modifier` | A test or a `describe` was left marked `.only` | Take the `.only` off |
| `This test reached for the network: ...` | A test let the application try a `fetch`, a DNS lookup, or an `http`/`https` request to an IP address other than loopback, at the address named: a webhook or a mail it set up and did not stand in for | Install `effects()` in the test. See [Testing](testing.md#proving-a-request-is-all-or-nothing) |
| Every test of a file fails with `N migration(s) did not apply to a fresh database` | A file under `drizzle/` does not apply to an empty database. The built server would stop at start-up in the same way | Fix the migration file. See [Changing the Schema](#changing-the-schema) |
| A failure under "the checked-in copy of the model" in `tests/migrations.test.ts` | `expected-schema.ts` is out of date. `docker build` would stop on the same thing | `npm run schema:expected`, and commit the result |
| `Tests must run against an in-memory database` | The suite was started in some way that did not set `DB_PATH` | Run it with `npm run verify` or `npm test`, never with `DB_PATH` set by hand |

**When the build stops at `RUN npm run verify`.** Nothing has been deployed and the running container is untouched. Then:

1. Read which tests failed. Docker's default output can cut a failed step short, so build again with all of it: `docker build --progress=plain -t dumpfire:candidate . 2>&1 | tee build.log`, and look above the `Test Files` line for each `FAIL`.
2. Run `npm run verify` on a workstation, on the same commit (`git status` clean, `git log -1` the commit the host built).
3. **If it fails there too**, it is one of the rows above. Fix it, run it again, push, and build again.
4. **If it passes there and fails in the build**, the difference is between the two places and not in the change itself. The likely causes are a file the test needs that was never committed, or that `.dockerignore` keeps out of the build; a file name whose capitals differ from the name the code asks for, which Windows forgives and Linux does not; a path built with `\`; line endings, which are CRLF in some files of a Windows working copy and LF in every file of a Linux checkout; and a test that depends on how long something takes. Correct the test or the file so that it holds in both places.
5. **Do not take the line out of the `Dockerfile` to get an image**, and do not skip the failing test. The last image that built is still on the host: a failed build makes no image and moves no tag.

On the Docker host itself there is usually no Node to run the suite with outside the build, which is why the quick check is made before the commit gets there.

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `NODE_ENV` | `production` | No | Node.js environment mode |
| `PORT` | `3000` | No | HTTP port the server listens on |
| `ORIGIN` | `http://localhost:3000` | **Yes** | Public URL — must match your domain exactly. Incorrect value causes CSRF failures. It is also the address every link in a mail begins with, unless an App URL is set: see [Where a Mailed Link's Address Comes From](#where-a-mailed-links-address-comes-from) |
| `APP_URL` | not set | No | The address links in mail begin with, when it should not be `ORIGIN`. The App URL on the admin page, under Application Settings, does the same and is read first |
| `PROTOCOL_HEADER` | `X-Forwarded-Proto` | No | Header from reverse proxy indicating HTTPS. Read only when `ORIGIN` is not set |
| `HOST_HEADER` | `X-Forwarded-Host` | No | Header from reverse proxy with original hostname. Read only when `ORIGIN` is not set, and never for a link in a mail |
| `ADDRESS_HEADER` | not set | Behind a proxy, yes | The request header that names the caller's address, set by the proxy: `X-Forwarded-For` behind the nginx block below. Not set in the image, and not to be set without a proxy in front: see [The Caller's Address Behind a Proxy](#the-callers-address-behind-a-proxy) |
| `XFF_DEPTH` | `1` | No | With `ADDRESS_HEADER=X-Forwarded-For`, how many proxies there are in front of the server: the address is read that many places from the end of the header. `1` for the nginx block below |
| `BODY_SIZE_LIMIT` | `512M` in the image; `512K` for a server started any other way | No | The largest request body the server accepts on any route. Bytes, or a number followed by `K`, `M` or `G`: `512M`, not `512MB`, which is no number to the server and **stops it starting**. `Infinity` is no limit. The application narrows it again route by route: see [Upload Size Limits](#upload-size-limits) |
| `DB_PATH` | `/app/data/dumpfire.db` in the image; `dumpfire.db` in the working directory for a server started any other way | No | The database file. It must be on the volume: the uploads are in the folder `uploads` beside it. The image sets it since card 2083; an image built before that sets none, and a container from it started without `DB_PATH` keeps its database at `/app/dumpfire.db`, inside the container. At the image's path, a server that finds no database there, or an empty file, while it can see a database file at `/app/dumpfire.db` or elsewhere in `/app/data`, or a `dumpfire.db-wal` without its database, **refuses to start** rather than create an empty one: see [Start-Up Sequence](#start-up-sequence) |
| `LOG_LEVEL` | `INFO` | No | Lowest level logged: `DEBUG`, `INFO`, `WARN`, `ERROR` or `CRITICAL`. Leave it at `INFO` or `WARN` when updating: the migration runner reports what it applied and rebuilt at `WARN` |
| `LOG_RETENTION_DAYS` | `30` | No | How long rows are kept in `system_logs`. The table is also capped at 50,000 rows, whatever their age |
| `SCHEDULERS` | `on` in a built server, `off` under `npm run dev` | No | `on` or `off`: whether the backup, report and snapshot schedulers and the attachment file sweep run. Set it to `off` for any instance that holds production's data and is not production. Such an instance holds production's backup destinations, report schedules and mail settings, and with its schedulers running it backs up to production's destinations, prunes the backups there and sends production's reports. When they are off, one `[WARN] [SCHEDULERS]` line at start says so: `Schedulers are off (…). No scheduled backup, report, snapshot or attachment file sweep will run from this instance. Set SCHEDULERS=on to run them.` "Run Backup Now" in the admin panel works either way, and so do email and webhooks sent in answer to an action. To make such a copy harmless in itself, import the backup as a working copy: see [Admin Guide](admin-guide.md#restoring-from-backup) |
| `PASSWORD_THREADS` | not set: two, or one on a machine with one or two CPUs | No: **leave it unset** | How many worker threads hash and check passwords, so that the server's own thread is never held by one (card 2191). Unset, it is `min(2, max(1, CPUs - 1))`. A whole number from `0` to `8` is taken as it is; `0` checks every password on the server's own thread, as the tests do, which holds every other request for about a fifth of a second each time, and is not for a server. Anything else is one `[WARN] [AUTH]` line, `PASSWORD_THREADS="…" is not a whole number from 0 to 8: password checks run on N worker thread(s)`, and the default. Read once, at the first check. See [Password Hashing](authentication-security.md#password-hashing) |
| `SIGN_IN_ONE_AT_A_TIME` | not set, which is `on` | No: **set it only as** [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out) **says, and remove it after** | `on` or `off`, in any case, trimmed; empty is `on`. `off` turns off the rule that holds sign-ins from browsers not remembered for an account to one at a time while the account is being guessed at (card 2194): every browser is then let in after the account's wait. While it is `off`, one `[WARN] [STARTUP]` line at every start says so, to the console whatever `LOG_LEVEL` is. Anything else is one `[WARN] [AUTH]` line, `SIGN_IN_ONE_AT_A_TIME is "…", which is neither on nor off: sign-ins from browsers not remembered are held to one at a time`, and `on`. Read once, at start. See [Browsers That Have Signed In Before](authentication-security.md#browsers-that-have-signed-in-before) |
| `CSP_MODE` | not set, which is `enforce` | No: **set it only for the first deploy of the policy**, as [The Update That Brings the Content-Security-Policy](#the-update-that-brings-the-content-security-policy) says, **and remove it after** | `enforce` or `report-only`, written exactly so. `report-only` sends every page its Content-Security-Policy as `Content-Security-Policy-Report-Only`: the browser names in its console what the policy would refuse, and refuses nothing. While it is set, one `[WARN] [STARTUP]` line at every start says so, to the console whatever `LOG_LEVEL` is. Any other value, `REPORT-ONLY` and ` report-only` among them, is enforced, and one `[WARN] [STARTUP]` line at every start names it: `CSP_MODE is "…", which is neither enforce nor report-only: the Content-Security-Policy is enforced.` Read at every request. See [The Content-Security-Policy](authentication-security.md#the-content-security-policy) |
| `WEBHOOK_ALLOW_INSIDE` | not set: no webhook may send inside the network | Only for a webhook receiver inside the network, such as an automation tool beside DumpFire | A list, separated by commas, of the host names, addresses and ranges inside the network that webhooks may send to (card 2161): `n8n`, `host.docker.internal`, `10.0.5.20`, `10.0.5.0/24`, `fd00::/8`, `[fd00::1]`. A name is exact, case ignored, final dots removed, and allowed whatever it resolves to inside, but never `0.0.0.0` or `::` (a DNS filter's answer for a blocked name); an address or range must lie wholly inside one of the inside ranges, or it is ignored and named in one `[WARN] [STARTUP]` line at every start. Read when a webhook is registered and at every delivery, and parsed again when its value changes; set it when the container is created. An entry trusts every account that can register a webhook with every port and path on that host, so name a dedicated host or address, never `host.docker.internal` while anything else listens on the Docker host; an entry with a port (`n8n:5678`) is not taken. A board's owner, which any account can be, also reads back what each allowed port answers, in the webhook's `lastDelivery` (card 2178): a web server's status, a certificate a TLS server presents, or not reached. See [Where a Webhook May Send](#where-a-webhook-may-send) |
| `NODE_EXTRA_CA_CERTS` | not set | Only for a mail server whose certificate comes from a private authority, or is self-signed | The path, inside the container, of a PEM file of certificates Node trusts beside its own, for every TLS connection of the process: mail, webhook deliveries and backup destinations (card 2189). Read once, when the process starts: set it, with the file mounted read-only, when the container is created; a restart applies neither. See [Mail Server Certificates](#mail-server-certificates) |

> ⚠️ **CRITICAL**: `ORIGIN` must be set to your actual public URL (e.g. `https://dumpfire.example.com`). Leaving it as localhost will cause CSRF token validation failures on all form submissions.

### Where a Mailed Link's Address Comes From

An invite, a request's confirmation and reply links, and the "View Task" link in a notification all begin with the server's own address. That address is configuration, and never anything a request says:

1. the **App URL** on the admin page, under Application Settings (the superadmin's);
2. failing that, the `APP_URL` variable;
3. failing that, `ORIGIN`.

No request header is read for it: not `Host`, and not `X-Forwarded-Host`. With no App URL set, a link used to take its host from `X-Forwarded-Host`, so whoever could send the server a request could have an invite mailed with a link to a host of their choosing, and an invite sets a password.

The image is built with `ORIGIN=http://localhost:3000`. A server that really is reached there is right as it is. One behind a proxy that was started without `ORIGIN` mails links that begin with `http://localhost:3000`, and says so once at every start: `[WARN] [STARTUP] ORIGIN is http://localhost:3000, the address the image is built with, and no App URL is set...`. Set `ORIGIN`, or the App URL.

A server started with no `ORIGIN` at all, which the image never is, and given no App URL has no address. Then two things are refused with `503` and "This server has no address configured to make the link from", before anything is saved: an invite, which is a link, and a public request made by somebody who is not signed in, when SMTP is configured, because that request waits on a mailed link to be confirmed. A user added with a password, a request made by somebody signed in, and any request made while no SMTP is configured have no link to mail, and are accepted. A notification is not sent: each one skipped is a `[WARN] [NOTIFY]` line.

### Mail Server Certificates

Since card 2189 every mail is sent over a checked, encrypted connection. Port 465 is TLS from the first byte; any other port must offer STARTTLS, and a server that does not is refused (`ETLS`) before the password is sent; and on every port the mail server's certificate must be one Node trusts for the host's name as it is entered in **Admin → 📧 Email / SMTP**. Until then mail on any port but 465 went without requiring STARTTLS and without checking the certificate, so anyone on the network path to the mail server, or who could answer for its name, could read the mail password and every message, invites (whose link sets a password) included. How the connection is made: [Connection Handling](notifications-email.md#connection-handling).

```mermaid
flowchart TD
    Mail["Any mail"] --> Port{"Port 465?"}
    Port -->|"yes"| Implicit["TLS from the first byte"]
    Port -->|"no"| Start["STARTTLS required"]
    Implicit --> Cert{"Certificate trusted<br/>for the host's name?"}
    Start --> Cert
    Cert -->|"yes"| Send["Sign in and send"]
    Cert -->|"no"| Refused["Refused: Send Test says why<br/>and names the two ways out"]
    CA["NODE_EXTRA_CA_CERTS<br/>set when the container is created"] -.->|"adds to what is trusted"| Cert
    Way["The way out, ticked on the panel"] -.->|"any port but 465"| Old["STARTTLS if offered,<br/>certificate not checked"]
```

**A certificate from a private authority, or a self-signed one.** Mount the authority's certificate (or a self-signed server's own certificate), in PEM form, read-only into the container, and name it in `NODE_EXTRA_CA_CERTS`. Node reads it once, when the process starts, and adds it to what every TLS connection of the process trusts; the check stays on. There is no setting for it on the panel: one there would be kept in the database and in every backup, a second place that decides trust, set by a web session. **A restart does not apply it**: an environment variable and a mount are fixed when a container is created, and `docker restart` keeps both as they were. Create the container again with them:

```bash
docker run -d \
  --name dumpfire \
  --restart unless-stopped \
  -p 3000:3000 \
  -v dumpfire-data:/app/data \
  -v /srv/dumpfire/mail-ca.pem:/ca/mail-ca.pem:ro \
  -e NODE_EXTRA_CA_CERTS=/ca/mail-ca.pem \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=https://dumpfire.example.com \
  -e NODE_ENV=production \
  dumpfire:latest
```

Under Docker Compose, beside the lines of [Docker Compose](#docker-compose), then `docker compose up -d`:

```yaml
    volumes:
      - dumpfire-data:/app/data
      - /srv/dumpfire/mail-ca.pem:/ca/mail-ca.pem:ro
    environment:
      - NODE_EXTRA_CA_CERTS=/ca/mail-ca.pem
```

`/srv/dumpfire/mail-ca.pem` stands for wherever the file is kept on the host. The process trusts that authority for every TLS connection it makes, not only mail: webhook deliveries and backup destinations trust it too. A file that cannot be read is said by Node on the console at start, and the server starts without it.

**The way out.** "Allow mail without a checked, encrypted connection", on the panel, off by default, gives back the behaviour from before card 2189 on any port but 465: STARTTLS when offered, the certificate not checked. It is for a relay on this server's own network that cannot use TLS. Turning it on or off from the panel needs the mail password typed again, and writes one `[WARN] [SMTP]` line naming who did it. Two other ways set it with neither: the one-row write of [check 0i](#before-the-deploy-checks-0i-to-0k), which the mailer reads at the next mail with no restart, before or after the deploy; and a restore, which brings in the backup's setting with the backup's other mail settings. A restore keeps this server's mail password only where the backup's setting is this server's, and where it differs its "To enter again" line names the box: "the mail password (Admin, 📧 Email / SMTP, where the backup brought in "Allow mail without a checked, encrypted connection" ticked and this server had it unticked)". Port 465 is checked either way. See [SMTP Configuration](admin-guide.md#smtp-configuration).

**Check the mail server from the container.** Read-only: it reads the mail settings, prints names and flags and never the password, and makes the connection `createTransporter` (in `src/lib/server/email.ts`) makes, signing in to nothing and sending nothing (`verify()` with no `auth` connects, upgrades, checks the certificate and quits). It honours `NODE_EXTRA_CA_CERTS` as the container has it. Its options are `createTransporter`'s, which names this check in a comment: the two are changed together. It connects to the host exactly as stored, as `createTransporter` does, untrimmed: since the review-fix pass a host is saved trimmed of ASCII spaces and tabs, and one saved before with spaces is checked with them, as mail is sent. It prints `way out set` when "Allow mail without a checked, encrypted connection" is on. It holds no `!`, `$` or backtick:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
const host = get('smtp_host');
const port = Number(get('smtp_port') || '587');
console.log('mail host', JSON.stringify(host), '| port', port, '| way out ticked', get('smtp_allow_insecure') === 'true', '| user set', get('smtp_user').length > 0, '| password set', get('smtp_pass').length > 0, '| NODE_EXTRA_CA_CERTS', process.env.NODE_EXTRA_CA_CERTS || 'not set');
if (host.length > 0 && get('smtp_allow_insecure') === 'true') { console.log('way out set: mail goes on after the deploy as it goes today, whatever the check below prints.'); }
db.close();
if (host === '') { console.log('No mail host is set: nothing to check.'); } else {
  require('nodemailer').createTransport({ host: host, port: port, secure: port === 465, requireTLS: port === 465 ? false : true, tls: { rejectUnauthorized: true }, name: 'dumpfire.app', connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 }).verify()
    .then(() => console.log('PASS: the mail server gives an encrypted connection with a certificate this server trusts.'))
    .catch((e) => console.log('FAIL:', e.code || '', e.message));
}
"
```

It checks the connection without the way out, whatever the panel has, so it says whether the way out could be turned off. With the way out set, mail goes as it did before card 2189 whatever the check says, and `way out set` is printed above it. What it prints:

| It prints | It means | What to do |
|---|---|---|
| `PASS` | Mail goes over a checked, encrypted connection | Nothing |
| `way out set` | "Allow mail without a checked, encrypted connection" is on: mail goes without the check | Nothing for mail to go on. The line below it says whether the way out could be turned off |
| `FAIL: ETLS Error upgrading connection with STARTTLS…`, or `FAIL: ECONNECTION EHLO failed but HELO does not support required STARTTLS…` | The mail server offers no STARTTLS | Ask the provider for its TLS port (often 465) and enter it, or, for a relay on this server's own network that cannot use TLS, tick the way out, **with the mail password at hand**. Without the password, set it with the one-row write of [check 0i](#before-the-deploy-checks-0i-to-0k): it works after the deploy as well as before, and the mailer reads it at the next mail, with no restart |
| `FAIL:` … `self-signed certificate`, `unable to verify the first certificate`, `unable to get local issuer certificate` | Its certificate is from an authority this server does not trust | Try the authority first in the running container: `docker cp mail-ca.pem dumpfire:/tmp/mail-ca.pem`, then this check as `docker exec -e NODE_EXTRA_CA_CERTS=/tmp/mail-ca.pem dumpfire node -e …`. On `PASS`, mount the file read-only and set the variable when the container is created, as above. A restart applies neither. That `PASS`, with check 0k's run with `-e` and `-v`, is the go-ahead |
| `FAIL:` … `does not match certificate's altnames` | The host is entered as an address, or a name that is not on the certificate | Enter the certificate's name as the host, with the password typed again |
| `FAIL:` … `certificate has expired` | The mail server's certificate is out of date | The provider's to renew. Mail stops until it is; the way out meanwhile |
| `FAIL: ESOCKET connect…`, `EDNS`, or a timeout | The server cannot be reached from the container | Unrelated to certificates: mail is not working now either |

### Where a Webhook May Send

A webhook is not sent to an address inside the network (card 2161): loopback, the private
ranges Docker and an office use, carrier NAT and Tailscale, link-local with the cloud
metadata service at `169.254.169.254`, the reserved, documentation and multicast ranges, their
IPv6 counterparts, and the names `localhost`, `*.localhost`, a name with no dot (a service on
the same Docker network, `n8n`), `*.local`, `*.internal` (`host.docker.internal`) and
`*.home.arpa`. It is refused when the webhook is registered, as written, and at every delivery,
by every address its name resolves to. The full tables are in
[Where a Webhook May Send](notifications-email.md#where-a-webhook-may-send).

```mermaid
flowchart LR
    Hook["A webhook's address"] --> Inside{"Inside the network,<br/>as written or as resolved?"}
    Inside -->|"No"| Send["Sent"]
    Inside -->|"Yes"| Allowed{"Named by WEBHOOK_ALLOW_INSIDE?"}
    Allowed -->|"Yes"| Send
    Allowed -->|"No"| Refused["400 at registration,<br/>WARN and not sent at delivery"]
```

**A receiver that is inside on purpose** is let in by naming it in `WEBHOOK_ALLOW_INSIDE`, set
on the container:

| To let in | Set |
|-----------|-----|
| A container on the same Docker network, `http://n8n:5678/webhook/…` | `WEBHOOK_ALLOW_INSIDE=n8n` |
| A service on the Docker host, `http://host.docker.internal:8080/…`, only where nothing else listens on the host (see below) | `WEBHOOK_ALLOW_INSIDE=host.docker.internal` |
| A machine on the office network | `WEBHOOK_ALLOW_INSIDE=10.0.5.20`, or the narrowest range that holds the receivers, `10.0.5.0/24` |
| A receiver on a development machine, `http://localhost:9911/x` or `http://127.0.0.1:9911/x` | `WEBHOOK_ALLOW_INSIDE=localhost,127.0.0.1` |

- A name is allowed whatever it resolves to inside, and only that name: it passes the name
  rules. A listed name is never let reach `0.0.0.0` or `::`: a DNS filter answers `0.0.0.0` for
  a name it blocks, which would reach this server, so that answer is refused. An address or a
  range lets in any address inside it, written in the webhook's address or resolved from a
  name, but never one in `0.0.0.0/8` or `::`.
- An entry is kept only if it lies wholly inside one inside range. `0.0.0.0/0`, `::/0`,
  `::ffff:0:0/96`, a slip such as `10.0.0.0/2` for `10.0.0.0/24`, an address outside the
  network, `127.1` (an IPv4 address not written as four decimal numbers), a port, a path and a
  wildcard are each ignored, and named at every start: `[WARN] [STARTUP] WEBHOOK_ALLOW_INSIDE:
  "10.0.0.0/2" ignored: wider than one inside range`. The rest of the list applies. Read the
  start log after changing it.
- So is an entry that one inside range holds but that holds `0.0.0.0` or `::`, which reach
  this server whatever it listens on, or a range listed before the one that holds it:
  `0.0.0.0/8` and `0.0.0.0` (`it holds 0.0.0.0, …`), `::/8`, `::/96` and `::1/8` (`it holds ::,
  …`), anything else inside `::/8`, and an IPv4-mapped range written with a short prefix,
  `::ffff:10.0.5.0/24`, which is `::/24` and held `::1` (`an IPv4-mapped range needs /96 or
  more`: write `10.0.5.0/24`, or `::ffff:10.0.5.0/120`). These rules shut out `0.0.0.0`, `::`
  and the reserved forms only. They do not stop an entry that names this server on purpose (`127.0.0.1`, `::1`, `localhost`), as a development installation's
  does, nor one that names a host where other things listen (the next point).
- **An entry trusts every account with every port and path on that host.** Anyone who can
  register a webhook, an editor of any board, can send to any port and any path of a host or
  range the list names, and an entry with a port (`n8n:5678`) is not taken, so the port cannot
  be narrowed. Name a dedicated host or address for the receiver, and the narrowest range. Do
  not list `host.docker.internal`, or the Docker host's address, while anything else listens
  on the host (an admin interface, a database, another application): every webhook could
  reach it. Nor list a range that holds this container's own address: its Docker network
  (`172.16.0.0/12`, or the narrower network it is on, which `docker network inspect` shows)
  opens this server too. Name the receiver's single address or name instead. A board's owner
  also reads back, in the webhook's `lastDelivery` (card 2178), what each port of a listed
  host answers: a web server's status, a certificate a TLS server presents, or not reached.
- A receiver's address with a user name or password is refused whatever the list says.
- It is read where a webhook is registered and at every delivery, and parsed again whenever
  its value changes. On a container the value changes only when the container is made again,
  so set it with `-e WEBHOOK_ALLOW_INSIDE=…` (or under `environment:` in a compose file) when
  the container is created.

**No proxy.** Webhooks are delivered directly, never through `HTTP_PROXY`, `HTTPS_PROXY` or
`NODE_USE_ENV_PROXY`: through a proxy the check would judge the proxy's address, not the
receiver's. An installation whose only way out is a proxy could not deliver webhooks before
(Node's `fetch` went direct too) and cannot now.

**Nothing on the host should trust a request for coming from the host's own address.** A
webhook to this server's own public IPv4 or IPv6 address, or to a name that resolves to one,
is outside by the tables: it leaves the container, turns at the host, and reaches what listens
there from the host's own address, inside the cloud firewall. Every port is open to webhooks,
since closing them would not close this (443 on that address is the proxy). So no proxy rule,
admin interface or service on the host may let a request in because it comes from the host's
own public address. See [Webhook Destinations](authentication-security.md#webhook-destinations).

## Running

### Minimal

```bash
docker run -d \
  --name dumpfire \
  -p 3000:3000 \
  -v dumpfire-data:/app/data \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=http://localhost:3000 \
  dumpfire:latest
```

The image sets `DB_PATH=/app/data/dumpfire.db` since card 2083, and each of these gives it all the same, so that each is right for an image built before that as well. Such an image sets none, and without it the database and the uploads are in `/app`, inside the container and off the volume: see [Volume Mounts](#volume-mounts). With any image, the volume at `/app/data` is what keeps them.

### Production

```bash
docker run -d \
  --name dumpfire \
  --restart unless-stopped \
  -p 3000:3000 \
  -v dumpfire-data:/app/data \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=https://dumpfire.example.com \
  -e NODE_ENV=production \
  dumpfire:latest
```

### Docker Compose

```yaml
version: '3.8'

services:
  dumpfire:
    build: .
    container_name: dumpfire
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - dumpfire-data:/app/data
    environment:
      - DB_PATH=/app/data/dumpfire.db
      - ORIGIN=https://dumpfire.example.com
      - NODE_ENV=production

volumes:
  dumpfire-data:
```

## Volume Mounts

| Container Path | Purpose | Persist? |
|---------------|---------|----------|
| `/app/data` | SQLite database + uploaded attachments | **Yes — required** |
| `/app/data/dumpfire.db` | Main database file: the image's `DB_PATH` | Auto-created at the first start, which says so in the log |
| `/app/data/uploads/` | Card attachments: the folder `uploads` beside the database file | Auto-created at the first upload |
| `/app/data/uploads/.trash/` | Attachment files of deleted cards, and files no attachment names, kept for 30 days | Auto-created at the first delete or sweep that has a file to move |

> 💡 Always mount `/app/data` as a Docker volume. Without it, all data is lost when the container is recreated.

The uploads folder follows `DB_PATH`: it is the folder named `uploads` in the directory that holds the database file. A variable `UPLOADS_DIR` exists for the tests and overrides that wherever it is set; do not set it in production, where it would move uploads away from the files already stored. The image sets `DB_PATH=/app/data/dumpfire.db`. An image built before card 2083 sets none, and a container from it started without `DB_PATH` has its database at `/app/dumpfire.db` and the uploads in `/app/uploads`, both inside the container and neither on the volume. Mounting nothing at `/app/data` does the same with any image: the folder is then the container's own, and every start says so in a `[WARN] [STARTUP]` line (see [Start-Up Sequence](#start-up-sequence)). To put either right, see [Moving the Database onto the Volume](#moving-the-database-onto-the-volume).

## Attachment Files

A file attached to a card is stored on disk, not in the database. The database holds a row for it, with the file's name; the file is at `uploads/<card id>/<file name>` beside the database.

> ⚠️ **Attachment files are in no backup.** A scheduled backup, "Run Backup Now" and the database export each hold the database and nothing else. Back the uploads folder up separately, or a restore brings back cards whose attachments cannot be opened.

> ⚠️ **Never point two instances at the same uploads folder.** A second instance that holds a copy of this one's data, such as a development copy or a rehearsal, has the same rows naming the same files. Deleting a card there moves this instance's files to the trash, a Reset there moves every one of them, and 30 days later they are removed for good. Two unrelated databases would mix their files in the same folders, because folders are named by card id and every database has a card 1, and an instance whose schedulers run sweeps every file its own rows do not name, a day after it was written, into the trash. Give every instance its own data directory.

```mermaid
flowchart TD
    Upload["A file is attached to card 12"] --> Live["uploads/12/report.pdf"]
    Live -->|"The attachment, its card, its column or its board is deleted,<br/>archived cards are purged, a board's cards are cleared,<br/>or the database is reset"| Trash["uploads/.trash/12/report.pdf<br/>with a marker file holding the date"]
    Live -->|"No attachment row names it, and it has not<br/>changed for 24 hours: the sweep"| Trash
    Live -->|"The card is archived"| Live
    Trash -->|"Import Backup restores a row<br/>that names the file"| Live
    Trash -->|"More than 30 days in the trash,<br/>ten minutes after a start or<br/>at a six-hourly maintenance tick"| Gone["Removed from disk"]
    Backup["Your own backup of<br/>the uploads folder"] -.->|"The only way back<br/>after 30 days"| Live
```

### The trash

- **A deleted card's files are moved, not removed.** They go to `uploads/.trash/<card id>/`, beside a marker file `.trashed-at` that holds the date. Archiving a card moves nothing.
- **They stay for 30 days.** A folder of the trash is removed once it was last added to more than 30 days ago. The period is fixed.
- **The trash is emptied by a timer, never at start-up.** The timer starts with the server, looks at the trash for the first time ten minutes after a start and then every six hours, so nothing is removed from disk as the server comes up. A server that is restarted more often than every six hours still empties its trash, at the ten-minute run after each start; one that is restarted more often than every ten minutes never does.
- **`SCHEDULERS=off` does not stop it.** The timer belongs to log maintenance, not to the backup, report and snapshot schedulers, and runs in every instance.
- **What it logs.** When a tick removes something, one `[INFO] [UPLOADS]` line says how many cards' files went. A folder that was due and could not be removed is reported in a `[WARN] [UPLOADS]` line and tried again at the next tick.
- **A file that cannot be moved to the trash stays where it was, for a day.** The delete has already been committed and is not undone. A `[WARN] [DELETE]` line names the files, the first ten where there are more, each by its card id and stored file name. The delete does not try again, but the sweep below does: once the file has not changed for 24 hours, no row names it, and the next sweep moves it.

### The sweep: files no attachment names

A file can be in a card's folder with no attachment row naming it: a move to the trash that failed, a server stopped between a delete's commit and its move, an upload stopped between writing its file and its row, an Import Backup whose rows leave some out, and every permanent delete made before card 2007, which left its files where they were. **The sweep (card 2107) moves such files to the trash**, where they stay 30 days like any other.

- **When.** It is one of the schedulers: the first run is 15 minutes after the start, then every six hours from that run. Nothing is moved at start-up itself. It runs only where the schedulers run, so it is off under `vite dev`, in a rehearsal and with `SCHEDULERS=off`; the trash is still emptied whatever `SCHEDULERS` says, by log maintenance.
- **What it reads.** Every attachment row, as `<card id>/<file name>`, and the highest card id this database has issued (the larger of the `cards` counter and the highest id in use), in one synchronous pass with the folder listing and the moves, so no request of this server can write a row in between. That protects against this process only: against a second process on the same volume the 24-hour margin is what protects.
- **What it never touches:**
  - a file a row names, in any case of its name: on Windows and macOS `Notes.TXT` and `notes.txt` are one file, which the row reads. On Linux, where they are two, no row reads a file named only in another case; it is left all the same, and the sweep counts such files in a `WARN` line;
  - a file changed in the last 24 hours (an upload writes its file before its row);
  - anything that is not a plain file in a folder named exactly by a card id, a whole number with no leading zero: `.trash` is skipped; any other name at the top of the uploads folder that is not a card's folder (`notes`, `07`, a link or a file) is left alone and named in a `WARN` line; links and folders inside a card's folder are skipped silently, with no line;
  - a folder numbered above the highest card id this database has issued: ids are never reused, so it was made by another database, and is left alone and named in a `WARN` line;
  - an empty card folder it did not empty itself (a folder it emptied goes, as a delete's does);
  - anything at all, when the rows or the counter cannot be read: one `WARN` line, and nothing is moved;
  - anything outside the uploads folder: every move goes through the trash's own move, which refuses a name that is not plain, and moves nothing into `.trash`, or a card's folder in it, that is a link (or a junction on Windows): such a file stays where it is and is named in the `WARN` for files that could not be moved.
- **Put back.** Import Backup within 30 days puts back any swept file that a restored row names, as it does for a deleted card's. A restore whose backup left `card_attachments` out says so in its answer; its files go to the trash at the next sweep, and an Import Backup that brings the rows within 30 days puts them back.
- **What it logs.** Nothing, when there was nothing to do. Otherwise:

  | Line | When |
  |---|---|
  | `[INFO] [UPLOADS] Attachment file sweep initialised: first run in 15 minutes, then every six hours` | At every start where the schedulers run |
  | `[INFO] [UPLOADS] Moved N attachment file(s) that no attachment names to the trash, from F card folder(s); E card folder(s) left empty were removed` | A run that moved anything |
  | `[WARN] [UPLOADS] N attachment file(s) that no attachment names could not be moved to the trash, and are where they were: …` | The first ten named; the next run tries again |
  | `[WARN] [UPLOADS] N attachment file(s) were left alone because an attachment names each only in another case: …` | A file in a card's folder whose name differs from an attachment's only in case. On Windows and macOS it is that attachment's file and the line can be accepted; on Linux no attachment reads it: find it (the row's name lowercased against the folder's) and rename or move it by hand |
  | `[WARN] [UPLOADS] N folder(s) in the uploads folder are numbered above the highest card id this database has issued (H), so were made by another database, and were left alone: …` | A fault to look into: another instance's files, or a folder copied in by hand |
  | `[WARN] [UPLOADS] N name(s) in the uploads folder are not a card's folder, and were left alone: …` | A name the sweep does not read as a card's folder, at every run until it is gone. Move it out of `uploads/`: a `.DS_Store` a Mac left, or a file or folder copied in by hand. A `lost+found` is at the root of a file system mounted at `uploads/` itself and cannot be moved: mount that file system at the data folder above instead, as the image's volume is, or accept the line |
  | `[WARN] [UPLOADS] Attachment files were not swept: the attachment rows or the card counter could not be read (…). Nothing was moved.` | The database could not be read |
  | `[WARN] [UPLOADS] Attachment files were not swept: …` | The uploads folder was refused, with why |
- **Two databases in one folder share one uploads folder.** The uploads folder is the folder `uploads` beside the database file, so a scratch database made beside `dumpfire.db`, for a test or a rehearsal on the host, has the live installation's files as its own. Started with the schedulers on, its sweep moves to the trash every file of the live installation that its own rows do not name, in every card folder numbered up to its own highest card id, a day after the file was written; 30 days later they are gone. Start a scratch database with `SCHEDULERS=off`, as [the rehearsal](#rehearsing-an-update-against-a-copy) does, or in a folder of its own, or with `UPLOADS_DIR` pointing at an empty folder of its own. (`UPLOADS_DIR` is for such a run and the tests; production never sets it.)
- **Disk space.** Deleting cards does not free the space their attachments use until 30 days later. To free it sooner, delete folders under `uploads/.trash/` by hand: the application has no way to empty the trash early. A file removed that way can no longer be put back by Import Backup.

### Backing up and restoring the files

Copy the whole uploads folder, the trash included. With the volume and path used in the examples on this page:

```bash
mkdir -p -m 700 "$HOME/dumpfire-uploads"
docker run --rm --network none -v dumpfire-data:/app/data:ro -v "$HOME/dumpfire-uploads:/backup" \
  dumpfire:latest sh -c 'if [ ! -d /app/data/uploads ]; then echo "No /app/data/uploads on the volume: nothing was copied. Check DB_PATH." >&2; exit 1; fi; cp -a /app/data/uploads/. /backup/ && ls -A /backup'
```

It lists what it copied. If there is no `/app/data/uploads` it copies nothing, says so and exits with status 1. That is so in two cases. No file has ever been attached: the folder is made at the first upload. Or the database is not on the volume, and the uploads are inside the container, beside the database. To tell which, with the container running:

```bash
docker exec dumpfire printenv DB_PATH
docker inspect --format '{{range .Mounts}}{{.Destination}}{{println}}{{end}}' dumpfire
```

If the first prints nothing, the container is from an image built before card 2083 and was started without `DB_PATH`: the uploads are in `/app/uploads` inside the container, and are lost when the container is replaced. If it prints a path, the uploads are in `uploads` in the folder that holds it, and that folder (normally `/app/data`) must be listed by the second command, or be inside a folder it lists. If it is not, the uploads are inside the container all the same: a container started from this image with no volume at `/app/data` prints `/app/data/dumpfire.db` and still has nothing on a volume. Checking `DB_PATH` alone says nothing since the image sets it. Copy them out of the container itself, running or stopped (shown for `/app/uploads`; for the image's own path it is `/app/data/uploads`):

```bash
mkdir -p -m 700 "$HOME/dumpfire-uploads-rescued"
docker cp dumpfire:/app/uploads/. "$HOME/dumpfire-uploads-rescued/"
ls -A "$HOME/dumpfire-uploads-rescued"
```

`docker cp` fails with a message if the container has no `/app/uploads`. For a `DB_PATH` set to somewhere else, the folder is `uploads` in the directory that holds that file.

The files are the attachments people uploaded, and nobody else on the host should be able to read them: `-m 700`, in both commands, makes the folder readable by you alone. The copy taken out of a container is a rescue, not a backup: move the files onto the volume with the database ([Moving the Database onto the Volume](#moving-the-database-onto-the-volume)), and once the next backup after that has been taken and checked, delete it (`rm -r "$HOME/dumpfire-uploads-rescued"`).

The first command replaces the server in a short-lived container, which is not started. It can be run while the application's container is up: an attachment file is written once and never changed afterwards. A file uploaded while the copy runs may be missed, so take the copy at about the time of the database backup it goes with.

What each way of restoring does with the files:

| Restore | The files |
|---------|-----------|
| **Import Backup**, in the admin panel | Files on disk are left where they are. For every attachment the restored database names whose file is missing from its card's folder and is in the trash, the file is moved back. The result on screen says how many were put back, and lists any that could not be |
| **By hand**, replacing `dumpfire.db` with the server stopped | Nothing is moved. Files that a delete had put in the trash stay there. Move each back from `uploads/.trash/<card id>/` to `uploads/<card id>/`, or restore your own copy of the folder taken with that backup |
| Either, more than 30 days after the cards were deleted | The trash no longer has the files. Only your own backup of the folder does |

An attachment whose file is not on disk still shows on its card. Opening it answers 404, "File not found on disk".

A copy of the database restored somewhere else, such as a working copy on a development instance, has the attachment rows and none of the files. That is expected: deleting a card there passes over the files it does not have.

## Start-Up Sequence

Every start of the container does the same work before the server accepts a request. The work is done by the application's own migration runner (`src/lib/server/db/migrate.ts`), which `hooks.server.ts` calls once as the server loads. Nothing else changes the structure of the database.

```mermaid
flowchart TD
    Start["Container starts: node build"] --> Where{"No database at DB_PATH, or an empty file,\nand a database file in sight elsewhere,\nor something it could not read?"}
    Where -->|"Yes"| Refuse["Write one CRITICAL DB line\non the console, naming each file.\nNothing is created"]
    Refuse --> Exit
    Where -->|"No"| Prep["Create system_logs if it is missing,\nand convert a legacy card_dependencies table"]
    Prep --> Files["Apply each unrecorded drizzle/*.sql file,\none transaction per file"]
    Files -->|"all applied"| Newer{"Does the database record a migration\nthis image has no file for?"}
    Newer -->|"Yes"| Skip["Log ERROR, and reshape nothing"]
    Newer -->|"No"| Recon["Reconcile six tables: rebuild any\nthat is not in the model's shape"]
    Recon -->|"rebuilt, or left as it was\nand logged at ERROR"| Fill["Repeat the four backfills"]
    Skip --> Fill
    Fill --> Newer2{"Reconciliation skipped\nabove?"}
    Newer2 -->|"No"| Stamps["Bring every timestamp to the stored form,\nYYYY-MM-DD HH:MM:SS in UTC, in one transaction.\nA failure is rolled back and logged at ERROR"]
    Stamps --> Check["Schema check: log any difference\nfrom the model at ERROR"]
    Newer2 -->|"Yes"| Check
    Check --> Users{"No user accounts, and a database\nat /app/dumpfire.db beside it?"}
    Users -->|"No"| Listen["Schedulers start,\nand 'Listening on' is printed"]
    Users -->|"Yes"| Both["Write one CRITICAL DB line\non the console, naming both files"]
    Both --> Exit

    Prep -->|"conversion fails"| Halt["Log CRITICAL"]
    Files -->|"a file fails or is refused"| Halt
    Recon -->|"foreign keys cannot be\nswitched back on"| Halt
    Fill -->|"fails"| Halt
    Halt --> Exit["Process exits with code 1.\nThe server never listens"]
```

Before any of it, before the database is even opened (opening a path creates the file), the server looks at where the database is (`src/lib/server/db/location.ts`, card 2083). What it does depends on what is at the path it is about to open:

- **A database with data there** (a regular file that is not empty): it opens it, whatever else is around. If a non-empty `dumpfire.db` is also in the working directory (`/app/dumpfire.db`) beside the image's `/app/data/dumpfire.db`, it says so at every start, and opens the image's.
- **A folder there, or a file it cannot look at** (permission denied, say): it does not judge, and the open says what is wrong.
- **Nothing there, or an empty file**, so that opening it would make a new, empty database. At the image's path, `/app/data/dumpfire.db`, it looks for a database that would be hidden: a non-empty `dumpfire.db` in the working directory (`/app/dumpfire.db`, where a server started without `DB_PATH` kept it); a non-empty file whose name ends in `.db`, in lower case, at the top level of `/app/data` (not in a folder beneath it, and not `dumpfire.db-wal`, `dumpfire.db-shm` or `dumpfire.db.backup-temp`); and a non-empty `dumpfire.db-wal` beside the missing database. At any other path, on Linux, it looks at the image's `/app/data/dumpfire.db`: an empty `DB_PATH` (`-e DB_PATH=`, or `${DB_PATH}` in a compose file with the variable unset) falls back to `/app/dumpfire.db`, and a typo such as `/app/data/dumpfire.sqlite` names a file that is not there, and either would otherwise open a new database beside the real one. Only regular files count. If it finds any of them, or cannot look at one of them, or cannot list `/app/data`, it **refuses to start**. If it finds none, it opens the new database and says so.

The refusal is one `[CRITICAL] [DB]` line on the console, which begins `The server will not start.`, names each file with its size and when it was last written (so that you can tell which is live), says what to do with each, names anything it could not read, and never says to delete a file; the process exits with code 1 and nothing is created. The line cannot go to `system_logs`, which is in the database. On a workstation there is no `/app/data/dumpfire.db`, so a scratch file is never refused; on Windows the image's path is never looked at. See [A Failed Start](#a-failed-start).

One more refusal comes after the migrations, before the server listens. If the database in use is the image's, has no user accounts, and a non-empty `/app/dumpfire.db` is beside it, the server **refuses to start** with one `[CRITICAL] [DB]` line naming both files with their sizes and times. That is a database the check above let through because one earlier start, by an older image or with a `DB_PATH` it did not guard, made it and wrote to it: with no users, set-up would be open to whoever comes first while the real database sits unused. A healthy installation has users, so this never stops one that is running on its own database with an old file beside it.

1. **Preparation.** The `system_logs` table is created if it is missing, and a `card_dependencies` table still in its original shape is converted to the current one.
2. **Migration files.** Every `.sql` file in `/app/drizzle` whose name is not yet recorded in the `__drizzle_migrations` table is applied, in file-name order. Each file runs in its own transaction, together with the row that records it, so a file is either applied in full and recorded or not applied at all.
3. **The first failure stops the server.** The failing file is rolled back, no later file is attempted, and the process exits with code 1 before it listens. Files this start had already applied stay applied and recorded.
4. **Reconciliation.** Six tables (`boards`, `columns`, `categories`, `settings`, `user_xp`, `invite_tokens`) reached older databases in two different shapes. Any of them that is not in the shape the model declares is rebuilt in it, with every row carried across. A table that cannot be rebuilt safely is left exactly as it was and reported; that does not stop the server. The whole step is skipped when the database records a migration this image has no file for, because that database may be newer than the image, and an older image must not reshape it.
5. **Backfills.** Three repairs that migrations made once are made again, in one transaction: the two values that `0050` and `0051` filled in (`cards.first_completed_at` and `task_requests.access_token`) for any row that lacks them, and `0057`'s statement, which takes a card out of a milestone that belongs to a board other than the card's (card 2179). A fourth, in the same transaction, takes out of its grouping any board filed under a dashboard grouping that no longer exists (card 2293), logged in a line of its own, `Took <n> board(s) out of a grouping that no longer exists: board <id> (grouping <id>), …`, the first 50 by id; it has no migration file, so its first run, at the first start after its deploy, is the one-off (see [Deleted Groupings, the Card Search, Unchanged Board Saves and a Goal's Archived Cards](#deleted-groupings-the-card-search-unchanged-board-saves-and-a-goals-archived-cards)). The first two are logged in one `WARN` line when they fill anything, the third in a line of its own: `Took <n> card(s) out of a milestone that belongs to another board: card <id> left milestone <id>, …`, naming the first 50 cards by id with the milestone each left (`; and <n> more` after them), since nothing else then records which goal held them. At a start the third finds cards only after a database file taken before 0057 was swapped in by hand, or a return from an older image (after Import Backup the restore runs it and reports it itself); a count at any other start means some write still makes such a card (see [The Update That Brings the Third Round of Read Leaks](#the-update-that-brings-the-third-round-of-read-leaks)). A failure of any of them stops the start, with the stage `backfilling cards.first_completed_at, task_requests.access_token, cards.milestone_id and boards.category_id`.
6. **Timestamps.** Every timestamp column (every TEXT column whose name ends in `_at`, and `system_logs.timestamp`) is brought to the one stored form, `YYYY-MM-DD HH:MM:SS` in UTC (card 2095). A value in ISO 8601, in the stored form with a fraction, or a bare date is rewritten to the same moment, to the second; a value in no form it can read is left as it is and reported at `ERROR`, at every start until it is dealt with. It runs in a transaction of its own: a failure is rolled back, logged at `ERROR`, and tried again at the next start, and the server starts. Like step 4, it is skipped when the database records a migration this image has no file for, and the `ERROR` line of step 4 says so. A start that converts anything says so in one `WARN` line, which is expected once after the update that brings card 2095 and after an Import Backup of an older backup, and at no other time.
7. **Schema check.** The whole database is compared with the model. Every difference is logged in one `ERROR` line. Nothing is changed and the server starts.

Expired sessions are then cleared, the system log is pruned to its retention, the backup, report and snapshot schedulers and the attachment file sweep start, and the server listens. On a database that is already up to date, steps 1 to 7 change nothing and log nothing.

Last, thirteen things about the installation are said in the log if they are so. None stops the server, and none changes anything: there are user accounts and none of them is the superadmin (`[CRITICAL] [STARTUP]`, see [If Nobody Can Sign In as the Superadmin](#if-nobody-can-sign-in-as-the-superadmin)); `ORIGIN` is still the address the image is built with and no App URL is set (`[WARN] [STARTUP]`, see [Where a Mailed Link's Address Comes From](#where-a-mailed-links-address-comes-from)); and a board hangs beneath one of its own cards, a loop left by a move made before card 2141, the legacy JSON import or a restored backup (`[WARN] [STARTUP]`, naming up to 20 such boards with the card each hangs from, see [A board beneath one of its own cards](admin-guide.md#a-board-beneath-one-of-its-own-cards) in the admin guide). The third reads the boards once and finds the loops in memory, so it costs next to nothing however deep the boards nest, and an import of a backup that brings a loop writes the same line at once, as `[WARN] [IMPORT]`, without waiting for the next start. The other three are about the database (card 2083), each a `[WARN] [STARTUP]` line: there was no database file, or an empty one, before this start opened it (`No database was at <path>: a new, empty one was created at this start.`, said once by a new installation, and the alarm on one that had data: stop the container before anyone opens the site); the folder the database is in is the container's own file system and not a mounted volume, at every start; and a database file is at `/app/dumpfire.db` beside the image's `/app/data/dumpfire.db`, which has data and is the one in use, at every start, naming both with their sizes and when each was last written. The seventh is that `SIGN_IN_ONE_AT_A_TIME` is `off` (card 2194), a `[WARN] [STARTUP]` line at every start while it is, written to the console whatever `LOG_LEVEL` is, as are the first two about the database: it is meant to be set for one sign-in and removed (see [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out)). The eighth is that `CSP_MODE` is `report-only`, or holds a value that is neither mode (card 2162), a `[WARN] [STARTUP]` line at every start while it does, written to the console whatever `LOG_LEVEL` is: `report-only` is meant for the policy's first deploy and then removed (see [The Update That Brings the Content-Security-Policy](#the-update-that-brings-the-content-security-policy)). The ninth is the secrets a backup does not hold that this installation still lacks (card 2169), one `[WARN] [STARTUP]` line naming them. The tenth is each entry of `WEBHOOK_ALLOW_INSIDE` that is ignored (card 2161), one `[WARN] [STARTUP]` line each, naming the entry and why: it is said here, once, because the list is read at every registration and every delivery, where a line would be written once for each webhook judged (see [Where a Webhook May Send](#where-a-webhook-may-send)). The eleventh is each board with more webhooks than the 10 a board may have (card 2201), in one `[WARN] [STARTUP]` line naming the first 20 by id and count, never an address: such a board was filled before the cap, keeps every webhook, and none can be added to it until it has fewer than 10. The twelfth is each webhook that is on and is refused as its address is written (an address inside the network that `WEBHOOK_ALLOW_INSIDE` does not name, a user name or password, or an address that is not http or https), in one `[WARN] [STARTUP]` line naming the first 20 by webhook and board, with why, never the path: it is not sent at any event, and no name is looked up for it. The thirteenth is each SFTP backup destination with no confirmed host key (card 2250), in one `[WARN] [STARTUP]` line naming the first 20 and then `; and N more`: no backup is sent to it until its key is confirmed with Test and Confirm, and where failure mail is off nothing else says so (see [An SFTP Destination's Host Key, Confirmed and Checked at Every Connect](#an-sftp-destinations-host-key-confirmed-and-checked-at-every-connect)). The last four are written at `WARN` like any line, so `LOG_LEVEL` at `ERROR` or above drops them. The first two about the database (no database file before this start, and the folder not on a mounted volume) are written to the console whatever `LOG_LEVEL` is, even `ERROR`, because the checks after a deploy look for them in `docker logs`; with `LOG_LEVEL` at `ERROR` or `CRITICAL` they are printed but not kept in `system_logs`, as for any line. The second knows a container's own file system from `/proc/self/mountinfo`: the mount that holds the folder is the root and an overlay (`overlay`, as Docker has it, `fuse-overlayfs`, as rootless Podman has it, or `aufs`), or it is `tmpfs`. A container on another storage driver (`btrfs`, `zfs`, `vfs`) is not recognised and nothing is said, and where there is no `/proc/self/mountinfo` (Windows, macOS) nothing is said either. An in-memory database has no folder and is not looked at. A check that cannot be made is said on the console, one line for each such check, and the server starts all the same.

Nothing at start-up touches the uploads folder. The log is pruned again every six hours, and the same six-hourly tick empties the [uploads trash](#the-trash) of what has been in it for more than 30 days; the trash is also emptied once, ten minutes after the start. Where the schedulers run, [the sweep](#the-sweep-files-no-attachment-names) looks at the card folders 15 minutes after the start, and every six hours from then.

What stops a start, and what is only reported:

| Found at start-up | Logged as | Does the server start? |
|-------------------|-----------|------------------------|
| At `/app/data/dumpfire.db`, no database or an empty file, while a database file is at `/app/dumpfire.db` or at the top of `/app/data`, or a `dumpfire.db-wal` is there without its database | `[CRITICAL] [DB]`, on the console only, naming each file, its size and time, and what to do with it | **No**. Nothing is created or changed. See [A Failed Start](#a-failed-start) |
| At any other path, on Linux, no database or an empty file, while `/app/data/dumpfire.db` has data (an empty `DB_PATH`, or a typo) | `[CRITICAL] [DB]`, on the console only, naming `/app/data/dumpfire.db` | **No**. Set `DB_PATH=/app/data/dumpfire.db`, or take the setting out |
| A new database would be made, and a file or folder the check needed could not be read | `[CRITICAL] [DB]`, on the console only, naming what could not be read | **No**. Let the server read it, or set `DB_PATH` to where the database is |
| After the migrations: the image's database has no user accounts, and a database file is at `/app/dumpfire.db` | `[CRITICAL] [DB]`, on the console only, naming both files | **No**. See [A Failed Start](#a-failed-start) |
| A migration file fails, cannot be read, holds no SQL statement, or holds a statement the runner refuses (see [Changing the Schema](#changing-the-schema)) | `[CRITICAL] [DB]` | **No** |
| `/app/drizzle` is missing or holds no `.sql` file (an image built without its migrations) | `[CRITICAL] [DB]` | **No** |
| The `card_dependencies` conversion or a backfill fails | `[CRITICAL] [DB]` | **No** |
| The third backfill took cards out of a milestone of another board (card 2179) | `[WARN] [DB] Took <n> card(s) out of a milestone that belongs to another board: card <id> left milestone <id>, …`, at that start, naming the first 50 (`; and <n> more`) | Yes. Expected at the first start after a database file swapped in by hand (a backup taken before 0057 copied over the database) and after a return from an older image, and at no other time: at any other start it is a fault to report. After Import Backup the restore makes the repair itself and reports it in its "Filled in" line, so no start line follows |
| Foreign keys cannot be switched back on after a rebuild | `[CRITICAL] [DB]` | **No** |
| One of the six tables cannot be rebuilt, or its rebuild fails its checks and is rolled back | `[ERROR] [DB]`, at every start until the cause is dealt with | Yes, with the table as it was |
| One of the six tables holds a value that the model's column type would store differently | `[ERROR] [DB]` for that table, at every start until a migration converts it | Yes; that table is as it was and the others are rebuilt |
| The database records a migration this image has no file for | `[ERROR] [DB]`, at every start | Yes; no table is rebuilt and no timestamp converted |
| Timestamps were found in another form and converted | `[WARN] [DB] N timestamp(s) converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC), each still naming the same moment to the second: <table.column n, …>. Expected once after the update that brings card 2095, and after an import of an older backup; at any other start something still writes another form.` | Yes. Expected once after this update; at any other start, a fault to report |
| A timestamp column holds a value in no form the conversion can read | `[ERROR] [DB] Timestamp column(s) hold values in no form this build can read, and they were left as they are: <table.column n (such as "…")>. …`, at every start until it is dealt with | Yes, with those values as they are. Correct each to `YYYY-MM-DD HH:MM:SS` in UTC, or clear it where the column allows NULL |
| The conversion failed | `[ERROR] [DB] Timestamps could not be brought to the stored form (YYYY-MM-DD HH:MM:SS, UTC), and none was changed: <why>. Start-up continues on the values as they are, and the next start tries again.` | Yes; nothing was converted. Until a start converts them, a report schedule whose next run is held in ISO 8601 runs up to a day late, because that comparison with now is made as text; a session's, an API key's or an invite's expiry is read as the moment it names, so each ends on time |
| The database differs from the model anywhere | `[ERROR] [DB]`, at every start | Yes; nothing is changed |
| There are user accounts and none of them is the superadmin | `[CRITICAL] [STARTUP]`, at every start until one is | Yes. Nobody can export, import, reset or change the backup and mail settings until one is made from the host |
| `ORIGIN` is `http://localhost:3000` and no App URL is set | `[WARN] [STARTUP]`, at every start | Yes; links in mail begin with `http://localhost:3000` |
| A board hangs beneath one of its own cards | `[WARN] [STARTUP]`, at every start until it is repaired, and `[WARN] [IMPORT]` at once after an import that brings one | Yes. The board is on no dashboard and its card cannot be completed; opening it is safe. See [A board beneath one of its own cards](admin-guide.md#a-board-beneath-one-of-its-own-cards) |
| There was no database file, or an empty one, and this start made a new one | `[WARN] [STARTUP]`, at that start | Yes, on an empty database, with set-up open. On an installation that had data, stop the container before anyone opens the site: see [Moving the Database onto the Volume](#moving-the-database-onto-the-volume) |
| The database's folder is in the container's own file system, not on a mounted volume | `[WARN] [STARTUP]`, at every start | Yes. The database and the uploads are lost when the container is replaced: move them onto a volume before it is |
| A database file is at `/app/dumpfire.db` beside `/app/data/dumpfire.db`, which has data | `[WARN] [STARTUP]`, at every start until one of them is moved | Yes, on `/app/data/dumpfire.db`. If the other is this installation's database, start with `DB_PATH` set to it, or move it onto the volume |
| `SIGN_IN_ONE_AT_A_TIME=off` | `[WARN] [STARTUP]`, at every start while it is set, on the console whatever `LOG_LEVEL` is: `SIGN_IN_ONE_AT_A_TIME=off: sign-ins from browsers not remembered are not held to one at a time. Remove it and restart once the sign-in it was set for is made: see docs/deployment.md, under "If an Attack Keeps an Owner Out".` | Yes. A guesser who sends many attempts at once at one account is slowed by its waits alone. Remove it and restart: see [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out) |
| `CSP_MODE=report-only` | `[WARN] [STARTUP]`, at every start while it is set, on the console whatever `LOG_LEVEL` is: `CSP_MODE=report-only: pages are sent the Content-Security-Policy to report only, not to enforce; remove CSP_MODE once the trial is over. See docs/deployment.md.` | Yes. Pages are not protected by the policy: a browser reports what it would refuse and refuses nothing. Remove it and make the container again: see [The Update That Brings the Content-Security-Policy](#the-update-that-brings-the-content-security-policy) |
| `CSP_MODE` holds anything but `enforce` or `report-only` | `[WARN] [STARTUP]`, at every start while it does, on the console whatever `LOG_LEVEL` is: `CSP_MODE is "<value>", which is neither enforce nor report-only: the Content-Security-Policy is enforced.` | Yes, with the policy enforced. Correct the value or remove it |
| A secret a backup does not hold is still to be entered (card 2169): the mail settings name a host and a user and hold no password; an S3, Google Drive or OneDrive destination lacks its credentials; or a webhook the database's `webhook_secrets_left_out` lists is still off with no secret | `[WARN] [STARTUP]`, at every start while it is so: `To enter again, because a backup does not hold them: <the mail password (Admin, 📧 Email / SMTP); backup destination(s) "…" (…) (Admin, Scheduled Backups); the signing secret(s) of webhook(s) N (board "…"), which stay switched off until the board's owner or an administrator sets each one's secret and switches it on with PUT /api/v1/webhooks/{id}, or deletes it if it is no longer wanted>. A database put in place by hand from a backup has none of them: see docs/admin-guide.md, Restoring from Backup.` A list that cannot be read is said on the console alone | Yes. Mail is not sent, those destinations are not tried, and those webhooks send nothing, until each is entered: see [Restoring from Backup](admin-guide.md#restoring-from-backup) |
| An entry of `WEBHOOK_ALLOW_INSIDE` that is not read, or is wider than one inside range, holds `0.0.0.0` or `::`, or is outside the network (card 2161) | `[WARN] [STARTUP]`, one line for each such entry at every start while it is set: `WEBHOOK_ALLOW_INSIDE: "10.0.0.0/2" ignored: wider than one inside range` (or `not inside the network, so it allows nothing`, `an IPv4 address not written as four decimal numbers`, `its range is not a number of bits`, `not a host name, an address or a range (a port, a path or a wildcard is not taken)`) | Yes, with that entry ignored and the rest of the list applied. Correct it and make the container again: see [Where a Webhook May Send](#where-a-webhook-may-send) |
| A board has more than 10 webhooks, made before the cap (card 2201) | `[WARN] [STARTUP]`, at every start while one has: `2 board(s) have more webhooks than the 10 a board may have: board 12 has 14, board 40 has 11. All of them are still sent, and none can be added to such a board until it has fewer than 10.`, the first 20 named and then `, and N more` | Yes. Every active webhook of such a board is still sent; look at each with the board's owner and delete the ones not wanted |
| A webhook that is on is refused as its address is written (card 2161) | `[WARN] [STARTUP]`, at every start while one is: `2 webhook(s) that are on are not sent, whatever their names resolve to: webhook 4 on board 3 (127.0.0.1 is a loopback address); webhook 9 on board 3 (n8n is a name with no dot, which is looked up inside the network). Each is refused at every event until its address is changed or it is switched off; one inside the network can instead be named in WEBHOOK_ALLOW_INSIDE.`, the first 20 named and then `; and N more` | Yes. Such a webhook is sent nothing; change its address, switch it off, or name its host in `WEBHOOK_ALLOW_INSIDE` |
| An SFTP backup destination has no confirmed host key (card 2250): none saved, as every SFTP destination saved before this card | `[WARN] [STARTUP]`, at every start while one has: `1 SFTP backup destination(s) have no confirmed host key, and nothing is sent to them until one is confirmed: "NAS". In Admin, Scheduled Backups, press Test on each and confirm the key it shows.`, the first 20 named and then `; and N more` | Yes. No backup is sent to such a destination: each scheduled run fails it, with its Backup History row and failure mail. Test and Confirm it: see [An SFTP Destination's Host Key, Confirmed and Checked at Every Connect](#an-sftp-destinations-host-key-confirmed-and-checked-at-every-connect) |

How the runner, the rebuild and the comparison work is described in [Data Model](data-model.md#migrations-and-schema-reconciliation).

## First-Run Setup

On a new, empty database the [start-up sequence](#start-up-sequence) applies every migration file before the server listens. What follows depends on whether anyone has an account yet:

```mermaid
flowchart TD
    Up["Start-up sequence completes,\nand the server is listening"] --> Check{"Any users\nin DB?"}
    Check -->|"No"| Setup["Redirect to /setup"]
    Setup --> Create["Create superadmin account"]
    Create --> Dashboard["Dashboard ready"]
    Check -->|"Yes"| Login["Redirect to /login"]
    Login --> Dashboard
```

1. Start the container
2. Visit the application URL
3. You'll be redirected to `/setup` to create the first superadmin account
4. After setup, `/setup` is permanently blocked

The start that made the new database says so in the log: `[WARN] [STARTUP] No database was at /app/data/dumpfire.db: a new, empty one was created at this start.` On a new installation that is expected, once. On an installation that had data it means the server is not looking where the data is, and set-up is open to whoever opens the site first: stop the container at once and see [Moving the Database onto the Volume](#moving-the-database-onto-the-volume).

## The Superadmin

The account made at set-up is the **superadmin**, and there is one. Its role is written by set-up and by nothing else: no page and no route makes a second, and an administrator cannot be promoted to it.

What acts on the whole installation is the superadmin's alone. An administrator who tries any of it is answered `403`, "This belongs to the superadmin", and the admin page does not offer it to them:

| The superadmin only | Why it is not an administrator's |
|---------------------|----------------------------------|
| Export Backup | The file holds every user's password hash and email and every webhook's address. Since card 2169 it holds no mail password, destination credential or webhook secret, and carries a seal made with a key this server keeps, so that only this server fills its secrets back into it, and only unchanged; files exported before then hold the secrets and no seal |
| Import Backup | It replaces every account with the backup's |
| Reset Everything | Whoever sets up afterwards is the superadmin |
| Scheduled Backups: the schedule, the destinations, "Test" and "Run Now" | A destination is sent the whole database, and a test connects with a stored password to whatever host it is given |
| Email / SMTP and the App URL | They decide which server an invite is handed to, and where its link points |

Everything else on the admin page is any administrator's: users and teams, clearing a board, purging archived cards, vacuuming, resetting XP, the system log and the audit trail. See [Admin Guide](admin-guide.md#who-may-do-what).

```mermaid
flowchart TD
    Setup["/setup, open while there are no users"] -->|"creates"| Super["The superadmin (one account)"]
    Super -->|"creates and promotes"| Admin["Administrators"]
    Admin -->|"create"| Users["Users"]
    Super --> Whole["Export, import, reset,\nbackup destinations, mail and App URL"]
    Admin --> Rest["Users, teams, boards,\npurge, vacuum, XP, logs"]
    Super --> Rest
    Host["The host: docker exec"] -.->|"the only other way\nto make a superadmin"| Super
```

> ⚠️ **Before you deploy the version that brings this in**, sign in on production as the superadmin. The user list on the admin page shows each account's role, so it shows who that is. If you cannot, use the command below first: the account you use day to day, if it is an administrator, loses Export, Import, Reset, Scheduled Backups and the mail settings with that deploy.

### If Nobody Can Sign In as the Superadmin

The superadmin's password is lost, or its account was deleted from the database by hand, or the database came from somewhere that had none. No page puts that right: only the superadmin could, and set-up is closed while there is any user. The server says so in the log at every start:

```
[CRITICAL] [STARTUP] There are 4 user account(s) and none of them is the superadmin. ...
```

The way back is from the host, with the application's own database driver. The image has no `sqlite3` command. Give the username of an existing account in place of `<username>`, exactly as it is written on the admin page:

```bash
docker exec <container> node -e "const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { fileMustExist: true }); const name = process.argv[1] || ''; const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(name); if (user === undefined) { console.log('No user is named [' + name + ']. Nothing was changed. The users are: ' + db.prepare('SELECT username, role FROM users ORDER BY id').all().map((u) => u.username + ' (' + u.role + ')').join(', ')); } else { db.prepare('UPDATE users SET role = ? WHERE id = ?').run('superadmin', user.id); console.log(user.username + ' was ' + user.role + ' and is now superadmin.'); } db.close();" <username>
```

It prints what it did:

| It prints | What happened |
|-----------|---------------|
| `greg was admin and is now superadmin.` | That one account's role was changed. Nothing else was |
| `No user is named [gerg]. Nothing was changed. The users are: greg (admin), ann (user)` | The name matched nobody, so nothing was written. It lists who there is |
| `SqliteError: unable to open database file` | `DB_PATH` in the container does not name a database. Nothing was written, and no file was created |

It runs while the server is running and takes effect at the next request: no restart. It changes no password, so name an account whose password is known. If none is, an administrator can set the password of an ordinary user on the admin page, and that user can then be named here; nobody but the superadmin can set an administrator's.

To check it:

```bash
docker exec <container> node -e "const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true }); db.prepare('SELECT username, role FROM users ORDER BY id').all().forEach((u) => console.log(u.username + ': ' + u.role)); db.close();"
```

At least one line should end `superadmin`. Then sign in as that user: the admin page has Application Settings, Backup & Restore, Scheduled Backups and Email / SMTP on it again, and the `[CRITICAL] [STARTUP]` line is not written at the next start.

If the old superadmin's account is still there, there are now two, and neither can manage the other's account. Make the old one an administrator with the same command, with `'admin'` in place of `'superadmin'` in the `UPDATE`, or delete it as the new superadmin once its role is changed.

An import cannot bring this about: a backup that has users and no superadmin among them is refused before anything is written. See [Restoring from Backup](admin-guide.md#restoring-from-backup).

### If an Attack Keeps an Owner Out

While an account is being guessed at with many attempts at once, sign-ins at it from browsers not remembered for it are let in one at a time, and the rest are refused at once: "A sign-in with this name is already under way from another browser. Wait a few seconds and try again, or sign in from a browser you have used here before." (card 2194). The guesser almost always holds that one place, so the account's owner, on a browser not remembered for the account, is refused for as long as the attack lasts. A browser the owner has signed in with, or signed out of, since the deploy that brought this in is remembered for a year and is never made to wait or counted. It is refused only while five of the account's own checks are already in flight: its remembered browsers' sign-ins and its signed-in sessions' current passwords together. See [Browsers That Have Signed In Before](authentication-security.md#browsers-that-have-signed-in-before).

The ways in, in the order to try them:

1. **A browser remembered for the account**, or a session already open on any browser: neither is touched.
2. **An invite**, from the admin page's 📧, only where mail is set up, and only for an account an administrator may manage: never the superadmin's, and an administrator's only from the superadmin. The invite signs the browser in without the sign-in page and remembers it. After an administrator has *set* a password during an attack, no browser is remembered for the account: send an invite instead.
3. **Waiting** until 15 minutes after the last wrong guess at the account.
4. **From the host, for one sign-in**, when none of those will do: the superadmin above all, whom no invite and no reset reaches.

The host's way, `SIGN_IN_ONE_AT_A_TIME=off`:

1. Make the container again with the setting. `docker restart` and `docker start` cannot add a setting: they start the container with the ones it was made with. Stop it, remove it (the database and the uploads are on the volume and stay), and run it again with the command it was first run with and `-e SIGN_IN_ONE_AT_A_TIME=off` added. `docker inspect <container>` before the `rm` shows the settings it had. For the [Production](#production) command above:

   ```bash
   docker stop dumpfire
   docker rm dumpfire
   docker run -d \
     --name dumpfire \
     --restart unless-stopped \
     -p 3000:3000 \
     -v dumpfire-data:/app/data \
     -e DB_PATH=/app/data/dumpfire.db \
     -e ORIGIN=https://dumpfire.example.com \
     -e NODE_ENV=production \
     -e SIGN_IN_ONE_AT_A_TIME=off \
     dumpfire:latest
   ```

   In Compose, add `- SIGN_IN_ONE_AT_A_TIME=off` under `environment:` and run `docker compose up -d`, which makes the container again itself. A restart empties every count, and the guesser's next five wrong passwords fill the account's again, so the setting is what lets the owner in, not the restart.
2. Check that `docker logs <container> 2>&1` has `[WARN] [STARTUP] SIGN_IN_ONE_AT_A_TIME=off: sign-ins from browsers not remembered are not held to one at a time. …`.
3. Sign in on the browser that is needed. It waits up to 4 seconds (the account's wait still applies), signs in, and is then remembered for the account.
4. Make the container again without the setting, the same way: `docker stop`, `docker rm`, and the first command without `-e SIGN_IN_ONE_AT_A_TIME=off` (in Compose, take the line out and `docker compose up -d`). Check that the line is no longer written.

While it is off, a guesser who sends many attempts at once at an account is held only by its waits and by each address's ten attempts in 15 minutes, as before card 2194.

**An attack on the line, not on one account, is another matter.** An attacker with many addresses can keep the second lane of password checks full, 150 checks for each thread, at any accounts or at none: a whole IPv6 /48 is 65,536 networks of /64, each with sign-in's ten attempts of its own. Every sign-in from a browser not remembered, every invite and set-up is then answered "Sign-in is very busy right now…", whoever it is. `SIGN_IN_ONE_AT_A_TIME=off` does not help with that: only a remembered browser or a session already open gets in, since their checks go in the first lane, and beyond that only the proxy's own limits, if it has any (nginx's `limit_req`, say), can hold such an attacker back.

**To forget every remembered browser of every account at once** (a laptop that held many is lost, or the key is thought to be known), delete the key they are signed with and restart. It is the row `known_browser_secret` of `settings`; no backup holds it. The image has no `sqlite3` command:

```bash
docker exec <container> node -e "const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { fileMustExist: true }); console.log(db.prepare('DELETE FROM settings WHERE key = ?').run('known_browser_secret').changes + ' key(s) deleted'); db.close();"
docker restart <container>
```

It holds no double quote inside its own, so it runs as written in bash and in PowerShell. The server holds the key in memory, so the restart is what ends the old cookies (a restart is enough here: nothing in the container's settings changes); a new key is made by the next browser to sign in. Everyone stays signed in, and each browser is remembered again at its next sign-in or sign-out. A remembered browser's cookie outlives its sessions: signing out, or a session ending, does not end it. To forget the browsers of one account only, set its password (the owner on the Account page, which keeps the browser that did it, or an administrator's reset, which keeps none). A restore of a backup and Reset Everything forget every browser too.

## Updating a Running Installation

An update replaces the container with one started from a newer image. The database stays where it is, and the new image brings it up to date in the [start-up sequence](#start-up-sequence).

> ⚠️ **The database stays where it is only if it is on the mounted volume.** Check before anything else, with the container running:
>
> ```bash
> docker exec dumpfire printenv DB_PATH
> docker inspect --format '{{range .Mounts}}{{.Destination}}{{println}}{{end}}' dumpfire
> ```
>
> If the first prints nothing, the container is from an image built before card 2083 and was started without `DB_PATH`: the server is using `/app/dumpfire.db`, which is inside the container and not on the volume. If it prints a path, the folder that holds it (normally `/app/data`) must be listed by the second command, or be inside a folder it lists; if it is not, the database is inside the container too. `DB_PATH` alone proves nothing since the image sets it. Either way, replacing the container discards the database and the uploads beside it: move them first, as [Moving the Database onto the Volume](#moving-the-database-onto-the-volume) says, before going any further. An image with card 2083 also says it at every start, `[WARN] [STARTUP] The database, <path>, is in the container's own file system`, in `docker logs dumpfire 2>&1` for as far back as the log goes.
>
> No check in a newer image can see a database inside the old container: a new container starts with a file system of its own. What a newer image can see, it judges by what is at the path it is about to open ([Start-Up Sequence](#start-up-sequence) has the whole rule):
>
> - It **refuses to start** when there is no database at that path, or an empty file, and it can see one elsewhere: a database file at `/app/dumpfire.db` (mounted there), a `*.db` file at the top of `/app/data`, a `dumpfire.db-wal` without its database, or, when `DB_PATH` is empty or names any other path, `/app/data/dumpfire.db` with data in it. It refuses as well when it would make a new database and cannot read something it needed to look at. And after the migrations, it refuses a database with no user accounts while a database file is at `/app/dumpfire.db` beside it. Each refusal is one `[CRITICAL] [DB]` line, and nothing is served (see [A Failed Start](#a-failed-start)).
> - It **opens and warns** when the database at its path has data and a database file is at `/app/dumpfire.db` beside it: one `[WARN] [STARTUP]` line at every start names both, with their sizes and times.
> - It **opens a new database and says so** when there is nothing at its path and nothing in sight: `[WARN] [STARTUP] No database was at <path>: a new, empty one was created at this start.` After an update, that line means the data is somewhere the new container is not looking: stop the container at once, before anyone opens the site and is offered set-up.

In outline:

1. **Run the tests** on the commit the new image will be built from: `npm run verify`, on a workstation, before the commit is pushed. If one fails, stop here. The image build runs them again, inside the image, and stops with no image if one fails there; running them first is the quick way to find out. See [Run the Tests Before You Build](#run-the-tests-before-you-build).
2. **Rehearse** the new image against a copy of the database whenever it brings a new file under `drizzle/`. See [Rehearsing an Update Against a Copy](#rehearsing-an-update-against-a-copy).
3. **Keep the old image** under a tag you can start again. The examples here call it `dumpfire:rollback`.
4. **Stop the old container and take a cold copy of the database**: the database file and the `-wal` and `-shm` files beside it, if they are there. SQLite runs in WAL mode, so the three files are one database and recent changes may be in the `-wal` file alone. They are only safe to copy together, with nothing holding them open. See [Taking and Returning the Cold Copy](#taking-and-returning-the-cold-copy).
5. **Start the new image** on the same data and read its log until a line beginning `Listening on` appears. It should take about as long as it did in the rehearsal.
6. If that line does not appear, or `docker ps` shows the container restarting, follow [A Failed Start](#a-failed-start).
7. **Have every open DumpFire tab reloaded.** A page left open keeps running the scripts of the release it was loaded from, against the new server. A request the new server reads differently can then fail with no word of why: an Account page loaded before the release that makes Generate Key ask for the password sends no password, and is refused with nothing shown. Administrators in particular reload the admin page before resetting anyone's password, so that the reset dialog is the new one and says what the reset ends.
   - **For the release that brings the update bar (card 2167), and any update to it from an older release**, reload every open tab by hand, and ask the people who use DumpFire to do the same. A page loaded from an older release never asks whether there is a new version.
   - **From the next update on**, each open page asks the server about once a minute and, within about a minute of the new image answering, shows a bar across the foot of the window: "DumpFire has been updated. Save anything you are editing, then reload to use the new version.", with a **Reload** button. It never reloads by itself, so nothing typed in a card's window or a form is lost, and the bar cannot be closed. A link or any other move to another page from it loads that page afresh, on the new version. Tell people to save what they are typing and press Reload when they see it.
   - **A restart of the same image shows no bar**: the version is the time the image was built. Going back to an older image is a new version, and shows it. Under `vite dev` the bar never shows. See [A page left open across a deploy](architecture.md#a-page-left-open-across-a-deploy).

```mermaid
flowchart TD
    New["New image started"] --> L{"'Listening on' printed?"}
    L -->|"No"| Stop["Stop it. Put the cold copy back.\nStart dumpfire:rollback"]
    L -->|"Yes"| E{"Any ERROR line\nfrom the DB context?"}
    E -->|"No"| Done["Update complete"]
    E -->|"Yes"| Read["The server is up.\nRead the line and act on it"]
    Done --> Later{"Need to go back later?"}
    Read --> Later
    Later -->|"Yes"| Image["Start the previous image on the database as it is.\nDo not put the cold copy back.\nDo not use Import Backup while it runs"]
```

### Moving the Database onto the Volume

For a container whose database is inside it, not on a volume: one from an image built before card 2083 started without `DB_PATH` (the database is `/app/dumpfire.db`), or one started with no volume at the folder of its `DB_PATH`. The database is three files, `dumpfire.db` and the `-wal` and `-shm` files beside it when they are there, and the uploads are the folder `uploads` beside them. All of it moves, with the container stopped. Before anything is copied, the container's own file system is kept as an image with `docker commit`: under Docker Compose, the next `docker compose up -d` recreates the service's container and removes the old one, whatever it has been renamed to, and what is inside it goes with it. The snapshot, and the copy on the host, are kept until the new container has been checked and the next backup has been taken.

```mermaid
flowchart TD
    Find["Find the container, and the volume\nat /app/data, from docker inspect"] --> Stop["Stop the old container.\ndocker commit it as dumpfire:pre-move,\nthen rename it. Do not remove it"]
    Stop --> Out["docker cp each file out by name,\nand the uploads folder,\ninto a folder only you can read"]
    Out --> Empty{"Has a newer image already\nmade an empty database\non the volume?"}
    Empty -->|"Yes"| Aside["Move it aside on the volume.\nNever delete it"]
    Empty -->|"No"| In
    Aside --> In["Copy the files into the volume\nfrom a short-lived container"]
    In --> Start["Compose: edit the file, then up -d.\nOr docker run with the volume at /app/data"]
    Start --> Log{"'Listening on', with no 'new, empty'\nand no 'own file system' line?"}
    Log -->|"Yes"| Done["Sign in. Remove the old container.\nAfter the next good backup, delete\nthe copy and the pre-move image"]
    Log -->|"No"| Halt["Stop it at once. The data is in\nHOME/dumpfire-move and in the\nimage dumpfire:pre-move"]
```

These are bash. Under Git Bash on Windows, run `export MSYS_NO_PATHCONV=1` first, so that the paths inside the container are not rewritten. That also leaves `$HOME` as `/c/Users/<you>`, which `docker.exe` does not understand, so on Windows set `move=$(cygpath -m "$HOME/dumpfire-move")` and write `"$move"` wherever the commands below say `"$HOME/dumpfire-move"`. `mkdir -m 700` protects nothing on NTFS: keep the folder in your own profile, which only you can read.

**First, find the names.** The container's name is in `docker ps` (under Compose it is often `<project>-dumpfire-1`). The volume is the one the container has at `/app/data`, if it has one: a volume made by Compose is named `<project>_dumpfire-data` (the README's example makes `dumpfire_dumpfire-data`), and one made by `docker run -v dumpfire-data:/app/data` is `dumpfire-data`. Read it from the container rather than guessing it:

```bash
c=dumpfire    # the container's name, from docker ps
docker inspect --format '{{range .Mounts}}{{.Type}}  {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}  ->  {{.Destination}}{{println}}{{end}}' "$c"
docker volume ls
```

Set `vol` to the name shown against `/app/data`. If nothing is mounted at `/app/data`, choose the name the new container will use (under Compose, `<project>_dumpfire-data`, where `<project>` is shown by `docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$c"`) and make it with `docker volume create "$vol"`; Compose then says the volume was not created by Compose, and uses it. Set `from` to the folder the database is in inside the old container: `/app` for one started without `DB_PATH`, or the folder of its `DB_PATH`. Set `img` to any DumpFire image you have, such as `dumpfire:latest`: the short-lived containers below run `sh`, never the server.

```bash
vol=dumpfire_dumpfire-data   # the volume found above
from=/app
img=dumpfire:latest          # any DumpFire image you have

# 1. Stop the old container, keep its own file system as an image, and keep the
#    container too, under another name.
docker stop "$c"
docker commit "$c" dumpfire:pre-move
docker rename "$c" dumpfire-old

# 2. Copy each file out by name, into a folder only you can read. docker cp takes no
#    wildcard. A missing -wal or -shm file is expected, and so is a missing uploads
#    folder when nothing was ever attached.
mkdir -m 700 "$HOME/dumpfire-move"
docker cp "dumpfire-old:$from/dumpfire.db" "$HOME/dumpfire-move/"
docker cp "dumpfire-old:$from/dumpfire.db-wal" "$HOME/dumpfire-move/" || echo "No -wal file: expected"
docker cp "dumpfire-old:$from/dumpfire.db-shm" "$HOME/dumpfire-move/" || echo "No -shm file: expected"
docker cp "dumpfire-old:$from/uploads" "$HOME/dumpfire-move/" || echo "No uploads folder: expected if nothing was attached"
ls -la "$HOME/dumpfire-move"
```

`mkdir -m 700` fails if `$HOME/dumpfire-move` is there already: that is a copy from an earlier attempt, so look at it before you move it aside, and never copy over it.

**A database bind-mounted as a single file** (`-v /srv/dumpfire.db:/app/dumpfire.db`) has its file on the host, but its `-wal` and `-shm` files are not: SQLite writes them beside the database, which is inside the container, next to the mount. `docker commit` keeps them (it keeps the container's own files, not what is mounted). Copy them out of the old container with the two lines above, and take the database file from the host if the first `docker cp` does not.

**If a newer image has already started on the volume and made a new, empty database there** (its log said `No database was at /app/data/dumpfire.db: a new, empty one was created at this start.`, and nobody has used the site since), that database is in the way. Move it aside on the volume, never delete it:

```bash
docker run --rm --network none -v "$vol:/app/data" "$img" sh -c \
  'd=/app/data/set-aside-$(date +%Y%m%d-%H%M%S) && mkdir "$d" && for f in dumpfire.db dumpfire.db-wal dumpfire.db-shm; do if [ -e "/app/data/$f" ]; then mv "/app/data/$f" "$d/"; fi; done; ls -la /app/data "$d"'
```

Then copy the files into the volume, with a short-lived container as the cold copy does. It copies nothing if a database is there already. It uses `cp -R`, not `cp -a`, so the files belong to the container's user and `/app/data` keeps its own owner and mode (`cp -a` would give the volume folder the copy folder's owner and its `700`, which a volume on NFS with root squashing, or a future image that does not run as root, could not open):

```bash
docker run --rm --network none -v "$vol:/app/data" -v "$HOME/dumpfire-move:/move" "$img" sh -c \
  'if [ -e /app/data/dumpfire.db ]; then echo "/app/data/dumpfire.db is there already: nothing was copied." >&2; exit 1; fi; cp -R /move/. /app/data/ && ls -la /app/data'
```

**Start the new image on the volume.** Under Docker Compose, edit the compose file: take out any line that mounts a file or a volume at `/app/dumpfire.db`, and give the service the volume at `/app/data` and `DB_PATH`:

```yaml
services:
  dumpfire:
    environment:
      - DB_PATH=/app/data/dumpfire.db
    volumes:
      - dumpfire-data:/app/data

volumes:
  dumpfire-data:
```

In a compose file whose `environment:` is a map rather than a list, the line is `DB_PATH: /app/data/dumpfire.db`.

Keep the rest of the service as it was. If `vol` is a volume you made with `docker volume create` under another name than Compose's, add `external: true` and `name: <that name>` under `dumpfire-data:` at the end. Then, in the folder of the compose file:

```bash
docker compose up -d
```

Compose recreates the service's container on the new settings, and removes `dumpfire-old`, which still carries the service's labels; the snapshot `dumpfire:pre-move` keeps what was inside it. Without Compose, start it as the [Production](#production) example does, with the volume and `DB_PATH`:

```bash
docker run -d --name dumpfire --restart unless-stopped -p 3000:3000 \
  -v "$vol:/app/data" -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=https://dumpfire.example.com dumpfire:latest
```

Then read what it said (under Compose, the container's name is in `docker compose ps`):

```bash
docker logs dumpfire 2>&1 | grep -E 'STARTUP|\] \[DB\] |Listening on'
```

`Listening on`, and neither `No database was at` nor `in the container's own file system`, is right: the site shows the sign-in page and the old accounts sign in. Then remove the old container if Compose has not (`docker rm dumpfire-old`). Keep `$HOME/dumpfire-move` and the image `dumpfire:pre-move` until the next backup has been taken and checked, then delete both: they hold the whole database and every attachment.

```bash
rm -r "$HOME/dumpfire-move"
docker image rm dumpfire:pre-move
```

If `Listening on` is missing, or either of the other lines is there, stop the new container at once, before anyone opens the site. The data is in `$HOME/dumpfire-move`, and inside the image `dumpfire:pre-move` at `$from`, whatever has become of the old container. To take a file out of that image again: `docker create --name pre-move dumpfire:pre-move`, then `docker cp "pre-move:$from/dumpfire.db" .` (and the same for the others), then `docker rm pre-move`.

### Taking and Returning the Cold Copy

These are for the volume and path the examples on this page use: the volume `dumpfire-data` mounted at `/app/data`, and `DB_PATH=/app/data/dumpfire.db`. Change both to match the installation. Each runs a short-lived container from the kept image with the volume attached and no network; the server is not started, because the command replaces it. Keep the copy outside the repository folder.

```bash
# Take it, with the application's container stopped, into a folder only you can read.
docker stop dumpfire
mkdir -p -m 700 "$HOME/dumpfire-cold"
docker run --rm --network none -v dumpfire-data:/app/data -v "$HOME/dumpfire-cold:/cold" \
  dumpfire:rollback sh -c 'cp -a /app/data/dumpfire.db* /cold/ && ls -l /cold'

# Return it. Only where the new image never printed "Listening on".
docker run --rm --network none -v dumpfire-data:/app/data -v "$HOME/dumpfire-cold:/cold" \
  dumpfire:rollback sh -c 'rm -f /app/data/dumpfire.db-wal /app/data/dumpfire.db-shm && cp -a /cold/dumpfire.db* /app/data/ && ls -l /app/data'
```

`dumpfire.db*` takes the database and whichever of its `-wal` and `-shm` files exist. Returning it removes those two first, so that none is left beside the database that the copy does not have.

The cold copy is the whole database, every account's password hash and session included, so `-m 700` keeps the folder readable by you alone (`mkdir -p` leaves the mode of a folder that is there already as it was: check it with `ls -ld "$HOME/dumpfire-cold"`). Once the update is complete and the next backup after it has been taken and checked, delete it: `rm -r "$HOME/dumpfire-cold"`.

### Reading the Log

Every line the application logs has the form `[time] [LEVEL] [CONTEXT] message`. The migration runner's context is `DB`.

- **Two streams.** The logger writes `WARN`, `ERROR` and `CRITICAL` lines to stderr. `Listening on` is printed by the web server on stdout. Read them together with `docker logs dumpfire 2>&1`.
- **What a successful update prints.** One line beginning `Applied migration:` for each file applied; one line for each table rebuilt, naming the table, the number of rows carried across and what differed in it; one line for each sub-board detached from a card that no longer exists; and one line if the backfills had anything to fill in. Then `Listening on`.
- **Those are `WARN` lines.** The default level, `INFO`, prints them. With `LOG_LEVEL=ERROR` they are not printed, and a successful update shows `Listening on` and nothing from the runner.
- **A timestamp line is expected once.** The first start of the release that brings card 2095 converts the timestamps production holds in ISO 8601 and says so in one `[WARN] [DB] N timestamp(s) converted to the stored form …` line, naming each column and its count. The next start says nothing. A line at any later start means something still writes the other form, and is a fault to report. After an Import Backup the same conversion is said as `[WARN] [IMPORT]`.
- **A new, empty database** is given every file. 25 statements in 19 of the oldest files repeat something an earlier file has already done and are skipped, each with a `WARN` line. That is expected.
- **Two `[STARTUP]` lines are about the Content-Security-Policy, not the update.** `CSP_MODE=report-only: pages are sent the Content-Security-Policy to report only, not to enforce; remove CSP_MODE once the trial is over. See docs/deployment.md.` is expected during the first deploy of the policy and nowhere else; `CSP_MODE is "…", which is neither enforce nor report-only: the Content-Security-Policy is enforced.` means the variable was mistyped. See [The Update That Brings the Content-Security-Policy](#the-update-that-brings-the-content-security-policy).
- **Judge a run by two markers and nothing else**: `[ERROR] [DB]` and `[CRITICAL] [DB]`. A `CRITICAL` line means start-up stopped. An `ERROR` line means the server started and something needs attention; the line says what, and it is repeated at every start until the cause is dealt with. Errors from other contexts, such as `[BACKUP]` or `[REPORTS]`, come from the schedulers and say nothing about the update.

```bash
# Nothing printed means the runner found nothing wrong.
docker logs dumpfire 2>&1 | grep -E '\[(ERROR|CRITICAL)\] \[DB\]'

# Everything the runner said, and whether the server came up.
docker logs dumpfire 2>&1 | grep -E '\] \[DB\] |Listening on'
```

Through the second command, a successful update looks like this, with one line for each table rebuilt. `docker logs` unfiltered shows three more `WARN` lines before `Listening on`, one from each scheduler as it starts:

```
[2026-10-12T09:14:03.512Z] [WARN] [DB] Applied migration: 0050_add_first_completed_at.sql
[2026-10-12T09:14:03.530Z] [WARN] [DB] Applied migration: 0051_add_request_access_token.sql
[2026-10-12T09:14:03.541Z] [WARN] [DB] Applied migration: 0052_drop_time_entries.sql
[2026-10-12T09:14:03.556Z] [WARN] [DB] settings rebuilt in the model's shape — 2 row(s) carried across. What differed, and no longer does: settings.key: is nullable; the model has it NOT NULL
Listening on http://0.0.0.0:3000
```

To find the rebuilt tables, search for `rebuilt in the model's shape`. No `ERROR` line contains the word "rebuilt", so the search finds those lines and no others.

There are two other lines of the same kind as the one below: `… were left in the shapes they have`, where several tables were stopped by one cause, and `… was not compared with the model`, where the comparison itself could not be made.

A table that was not rebuilt has an `ERROR` line of this form, which says why, that nothing in it was changed, and what to do. Other tables may have been rebuilt at the same start; their own lines say so:

```
[2026-10-12T09:14:03.556Z] [ERROR] [DB] settings was left in the shape it has, which is not the model's: settings.key is NULL in 1 row(s), and the model's column is NOT NULL with no default to give them. Nothing in it was changed, and the application runs on that shape as it has until now. Give key a value in those rows or delete them, and restart: UPDATE "settings" SET "key" = <a value> WHERE "key" IS NULL; or DELETE FROM "settings" WHERE "key" IS NULL; key is the table's key, so no two rows can be given the same value: where there are several, update them one at a time, adding AND rowid = <n>. It is reported at every start until the cause is dealt with.
```

### A Failed Start

What it looks like:

- One `[CRITICAL] [DB]` line. For a migration file it names the file, the position of the failing statement and its first line, what SQLite said about it, and the files this start had already applied. It ends by saying that the database is as it was before the failing step. A halt during reconciliation ends differently: it says what is known of whether a rebuild had been committed, and to start again. An error the runner did not anticipate has no `CRITICAL` line at all, and Node's report of it is then the whole account.
- Node then prints the error and its stack, and the process exits with code 1.
- `Listening on` never appears.
- With `--restart unless-stopped`, Docker starts the container again and it fails in the same way. `docker ps` shows it as restarting.

The `CRITICAL` line is also written to the `system_logs` table, after the failing file has been rolled back, so it is still there once the server is running again.

**A `[CRITICAL] [DB]` line about where the database is** is different. It begins `The server will not start.` and comes in one of two forms. Before the open: there is no database at the path (or the file there is empty), and it names each database file the server can see, with its size and when it was last written, and what to do with it, and anything it could not read. After the migrations: the database in use has no user accounts, and it names both files. The line is printed twice in `docker logs`: once as written, and again in Node's report of the error that stops the process, with its stack. Nothing is in `system_logs`, nothing was served, there is no cold copy to put back and no reason to go back to the previous image. Stop the container, so that it stops restarting, then do what the line says for the file that is this installation's database, and start again. A file that is not this installation's database is moved out of that folder.

- **Start with `DB_PATH` set to the file.** A container keeps the environment it was created with, so `docker start` (and `docker restart`) starts it with the old `DB_PATH` again. It must be created anew. Under Docker Compose, set `DB_PATH` in the service's `environment:` and run `docker compose up -d`, which recreates it. With `docker run`, `docker rm dumpfire`, then the same `docker run` with `-e DB_PATH=<file>`. Only the container is removed: the volume and a file mounted from the host stay.
- **Rename a file on the volume to `dumpfire.db`**, with its `-wal` and `-shm` files, with the container stopped, in a short-lived container as the moving section does it (shown for `/app/data/kanban.db`; set `vol` and `img` as that section says). It renames nothing if a `dumpfire.db`, or a `-wal` or `-shm` file of that name, is there already (SQLite would otherwise replay another database's `-wal` onto the renamed one):

  ```bash
  docker run --rm --network none -v "$vol:/app/data" "$img" sh -c \
    'cd /app/data && if [ -e dumpfire.db ] || [ -e dumpfire.db-wal ] || [ -e dumpfire.db-shm ]; then echo "dumpfire.db, or its -wal or -shm file, is there already: nothing was renamed." >&2; exit 1; fi; for s in "" -wal -shm; do if [ -e "kanban.db$s" ]; then mv "kanban.db$s" "dumpfire.db$s"; fi; done; ls -la /app/data'
  ```

  If an empty `dumpfire.db` is there, made by an earlier start, move it aside first with the set-aside command in that section.
- **Move a file onto the volume**, or a database with no users aside: [Moving the Database onto the Volume](#moving-the-database-onto-the-volume) has the commands.

What to do:

1. Stop the container, so that it stops restarting.
2. Read the `CRITICAL` line. It says which file and why.
3. Either fix the cause and start again, or go back to the previous image. A failed file was rolled back and is not recorded, so the next start runs it again from its first statement. The files applied before it are recorded and are not run again.

### Going Back to the Previous Image

| Situation | What to do | What is lost |
|-----------|------------|--------------|
| The new image never printed `Listening on` | Stop it. Put the cold copy back: all three files, deleting any `-wal` or `-shm` file that is beside the database and is not in the copy ([the second command](#taking-and-returning-the-cold-copy)). Start `dumpfire:rollback`. | Nothing. Nobody was able to use the new image. |
| The new image has served requests | Start `dumpfire:rollback` against the database as it is. **Do not put the cold copy back.** | Nothing. Putting the cold copy back would discard everything done since it was taken. |

What the older image makes of a database the newer one has migrated depends on how old it is:

- An image that has this runner finds migrations recorded that it has no file for. It reports that in an `[ERROR] [DB]` line, rebuilds nothing, reports in a second line whatever differs from its own model, and starts. Both lines are expected for as long as the older image runs.
- An image from before this runner (one whose `drizzle/` directory has no `0050` file) makes none of these checks and starts without comment.

One request behaves differently under an image from before this runner once the database has been migrated. A `PUT` to `/api/v1/columns/{columnId}` or `/api/columns/{id}` carrying `"wipLimit": null` is answered 500, because that image passes the null to the database and `columns.wip_limit` no longer accepts one. Send 0, which means the same thing: no limit. The board page is not affected, because that image sends 0 when the box is emptied. Nothing is damaged by the failed request, and the newer image does not have the fault.

When the newer image is started again it finds its migrations already recorded, repeats the backfills for rows created in the meantime (taking out of their milestones, since card 2179, the cards the older image left in a milestone of another board, in one `WARN` line), converts any timestamp the older image wrote in ISO 8601 (one `[WARN] [DB]` line), and carries on.

> ⚠️ **While an older image is running, do not use Import Backup (Admin → Backup & Restore).** An image from before this runner replaces the migration record along with the data. Restoring a backup that was taken before the update leaves a database that has the new columns and a record that says migrations `0050` onward never ran. The newer image then tries to apply `0050` again, fails on a column that already exists, and stops at every start. That image also leaves out every column whose WIP limit is NULL in the backup, because `columns.wip_limit` no longer accepts one, and commits all the same, so the cards on those columns are left pointing at nothing.

If that has happened, repair the record before starting the newer image. Check that the columns `cards.first_completed_at` and `task_requests.access_token` exist, then record the three files again:

```sql
INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES
  ('0050_add_first_completed_at.sql'),
  ('0051_add_request_access_token.sql'),
  ('0052_drop_time_entries.sql');
```

The image has no `sqlite3` command, and the newer image must not be started until this is done, so run it in a short-lived container from the newer image with the volume attached. The command replaces the server, which is not started. Change the volume and `DB_PATH` to match the installation:

```bash
docker run --rm --network none -v dumpfire-data:/app/data -e DB_PATH=/app/data/dumpfire.db \
  dumpfire:candidate node -e "
const db = require('better-sqlite3')(process.env.DB_PATH);
const has = (table, column) => Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column));
if (has('cards', 'first_completed_at') === false || has('task_requests', 'access_token') === false) {
  throw new Error('The two columns are not both there. Do not record the files: this is another fault.');
}
const record = db.prepare('INSERT INTO __drizzle_migrations (hash) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = ?)');
for (const name of ['0050_add_first_completed_at.sql', '0051_add_request_access_token.sql', '0052_drop_time_entries.sql']) record.run(name, name);
console.log(db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get().n + ' migrations recorded');
"
```

**Recording the files is not the whole repair.** It lets the newer image start, on a database that is still missing the columns the older image left out. Once the newer image is running, restore the same backup again with Import Backup there: it keeps the migration record, stores those limits as 0 and brings every column back.

### Rehearsing an Update Against a Copy

A quicker check comes first and needs no Docker: `npm run rehearse -- path/to/backup.db`, on a workstation with the new code checked out, takes the migration runner over a copy of a downloaded backup and says what it applied and rebuilt and whether a row was lost. It starts no server, so it sends nothing. See [Testing](testing.md#rehearsing-the-runner-against-a-copy-of-a-real-database). It does not replace what follows, which rehearses the image itself.

A rehearsal starts the new image on a copy of the live database and checks four things: that it migrates the copy without an error, that a second start has nothing left to do, that the previous image still starts afterwards, and that a migration which fails really does stop the server.

> ⚠️ **Run every rehearsal container with `--network none`.** A copy of production carries production's schedules and credentials. Started with a network, it emails every scheduled report that has fallen due to its real recipients, and if a backup is due it uploads one to the real destinations and then deletes the oldest backups there to keep to the retention count. Both schedulers look for work once a minute from the moment the server starts. The helper below also sets `SCHEDULERS=off`, which stops the schedulers in an image that has that switch. An older image, such as the one kept for rolling back, ignores it, so the network stays off whichever image is started.

> ⚠️ **Treat the copy as secret.** It holds password hashes, live session tokens, API key hashes, the SMTP password, the backup destinations' credentials and the secret tokens in task requesters' links. Keep it off shared storage and delete it when the rehearsal is over.

The snippets are written for bash on the Docker host. Under Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first, or paths such as `/tmp/rehearsal.db` and `/rehearsal` are rewritten into Windows paths before Docker sees them.

Build the new image first, in the repository, and keep the image that is running:

```bash
docker tag "$(docker inspect -f '{{.Image}}' dumpfire)" dumpfire:rollback
docker build -t dumpfire:candidate .
```

Then do everything else in a directory outside the repository. `.dockerignore` keeps `*.db`, `*.db-shm` and `*.db-wal` out of the build context at any depth, so a copy of production left in a folder of the repository under one of those names is not sent to Docker. A copy under any other name is sent by the next `docker build` and kept in its build cache after the folder is deleted, and a copy inside the repository is one `git add` from being committed: keep it outside.

Take the copy from the running container. `VACUUM INTO` writes a complete, consistent copy while the server carries on, and `process.env.DB_PATH || 'dumpfire.db'` is how the server itself finds its database, so the snippet opens the file the server has open:

```bash
docker exec dumpfire node -e "
const Database = require('better-sqlite3');
const live = new Database(process.env.DB_PATH || 'dumpfire.db', { readonly: true });
live.prepare('VACUUM INTO ?').run('/tmp/rehearsal.db');
console.log(new Database('/tmp/rehearsal.db', { readonly: true }).pragma('integrity_check', { simple: true }));
"                                              # prints: ok
mkdir -p "$HOME/dumpfire-rehearsal" && cd "$HOME/dumpfire-rehearsal"
mkdir r1 r2
docker cp dumpfire:/tmp/rehearsal.db r1/dumpfire.db
docker cp dumpfire:/tmp/rehearsal.db r2/dumpfire.db
docker exec dumpfire rm /tmp/rehearsal.db
```

Define three helpers, in that directory:

```bash
# Start an image on a copy: no network, no schedulers, and DB_PATH pointing at the copy.
rehearse() {      # rehearse <container name> <image> <directory> [more docker run options]
  local name=$1 image=$2 dir=$3; shift 3
  docker run -d --name "$name" --network none \
    -v "$PWD/$dir:/rehearsal" -e DB_PATH=/rehearsal/dumpfire.db -e SCHEDULERS=off "$@" "$image"
}

# Everything the runner said, and whether the server came up.
runner_log() { docker logs "$1" 2>&1 | grep -E '\] \[DB\] |Listening on'; }

# Look inside a copy without starting the server.
inspect() {       # inspect <directory>
  docker run --rm --network none -v "$PWD/$1:/rehearsal" dumpfire:candidate node -e "
const db = require('better-sqlite3')('/rehearsal/dumpfire.db');
for (const name of ['boards', 'columns', 'categories', 'cards', 'settings', 'user_xp', 'invite_tokens', 'sessions']) {
  console.log(name + ': ' + db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n + ' rows');
}
console.log('migrations recorded: ' + db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get().n);
console.log('foreign key violations: ' + db.pragma('foreign_key_check').length);
console.log('time_entries: ' + (db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get('time_entries') ? 'present' : 'gone'));
if (db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('cards', 'first_completed_at')) {
  console.log('completed cards with no first_completed_at: ' + db.prepare('SELECT COUNT(*) AS n FROM cards WHERE completed_at IS NOT NULL AND first_completed_at IS NULL').get().n);
}
"
}
```

Then, in order:

| # | Do | Expect | A fault if |
|---|----|--------|------------|
| 1 | `inspect r1` | The row counts of the copy as it stands. Keep them. | — |
| 2 | `rehearse df-new dumpfire:candidate r1`, wait a few seconds, `runner_log df-new` | An `Applied migration:` line for each file the new image brings, a line for each table it rebuilds, then `Listening on` | Any line marked `[ERROR] [DB]` or `[CRITICAL] [DB]`; no `Listening on`; `docker ps -a` shows the container has exited |
| 3 | `docker rm -f df-new`, then `inspect r1` | The row counts of step 1, but `sessions: 0 rows` once migration 0053 has been applied (it ends every session, once). `migrations recorded` higher by the number of files applied. `foreign key violations` as in step 1: a rebuild carries across a row that already broke a key, and adds none. | Any other row count differs |
| 4 | `rehearse df-new dumpfire:candidate r1` again, then `runner_log df-new` | `Listening on` and nothing else: no file left to apply and no table left to rebuild | An `Applied migration:` line, or any line from `[DB]` at all |
| 5 | `docker rm -f df-new`, then `rehearse df-old dumpfire:rollback r1` and `docker logs df-old 2>&1` | `Listening on`: the previous image starts on a database the new one has migrated | It does not start |
| 6 | Start the candidate on `r2` with a migration that cannot succeed (commands below) | A `[CRITICAL] [DB]` line naming `9999_deliberate_failure.sql` and giving SQLite's message that the table does not exist; Node's report of the error; exit code 1; never `Listening on`. `runner_log df-fail` has the `Applied migration:` lines of the real files and no line for a rebuilt table, because tables are rebuilt only once every file has been applied. `inspect r2` counts the real files as recorded and not the extra one. | The container stays up, or the line lacks the file name or SQLite's message |
| 7 | `docker rm -f df-old df-fail`, then delete the rehearsal directory, with `r1`, `r2` and the extra `.sql` file in it | — | — |

```bash
# Step 6: a file that sorts after every real migration and refers to a table that does not exist.
echo 'SELECT * FROM deliberately_missing_table;' > 9999_deliberate_failure.sql
rehearse df-fail dumpfire:candidate r2 \
  -v "$PWD/9999_deliberate_failure.sql:/app/drizzle/9999_deliberate_failure.sql:ro"
docker wait df-fail                  # prints the exit code: 1. If it does not return, the server stayed up.
docker logs df-fail 2>&1 | tail -n 30
runner_log df-fail
inspect r2
```

With `SCHEDULERS=off` the candidate logs one `[WARN] [SCHEDULERS]` line saying its schedulers are off, and nothing from them after that. An image from before the switch starts its schedulers all the same, and under `--network none` they may log errors of their own after the first minute, because they cannot reach anything. Those are expected, which is one more reason to judge the run by the `[DB]` lines alone.

### The Update That Brings Migrations 0050 to 0052

The first update to an image that has this runner does more than a routine one, because it is the first time the six tables are brought to one shape. For that update only:

**Before the rehearsal**, count the NULLs the rebuild will meet:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true });
for (const [table, column] of [['settings', 'key'], ['user_xp', 'name'], ['invite_tokens', 'token'], ['columns', 'wip_limit']]) {
  console.log(table + '.' + column + ': ' + db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + column + ' IS NULL').get().n + ' NULL');
}
"
```

Expect 0 for `settings.key`, `user_xp.name` and `invite_tokens.token`. A table with a NULL key is left as it is and reported at every start until the row is dealt with; the server still starts and the other tables are still rebuilt. Any number is acceptable for `columns.wip_limit`: those become 0, which means no limit.

**In the rehearsal**, expect `Applied migration:` lines for `0050_add_first_completed_at.sql`, `0051_add_request_access_token.sql` and `0052_drop_time_entries.sql`, and a line for each table rebuilt. Which tables those are depends on the history of the database. The production database measured on 2026-10-12 needs five (`columns`, `categories`, `settings`, `user_xp`, `invite_tokens`), and a database that was created from the repository's migration files as they stood before this change needs two (`boards`, `categories`). Afterwards `inspect` should report `time_entries: gone` and no completed card without a `first_completed_at`.

**After the update**, two checks in the application confirm the foreign keys the rebuild sets. On the production database measured on 2026-10-12 only the first is a change. The second was already so there, and confirms that foreign keys are on:

| Do | Expect | A fault if |
|----|--------|------------|
| Create a category on a board, then delete that board | The category remains, belongs to no board, and can be changed by an administrator only | The category is deleted with the board |
| Permanently delete a card that has a sub-board | The sub-board is deleted with it | The sub-board remains |

### The Update That Brings Transactions and the Uploads Trash

The release that makes every write all or nothing, moves deleted cards' attachment files to a trash and changes how attachments are served (card 2007) brings no migration file and no change to the schema. On a database the previous update has already brought up to date, its start-up has nothing to apply.

> ⚠️ **Deploy it only after the update that brings migrations 0050 to 0052 has been deployed and has settled.** Do not go from an image older than that one straight to this release. Take the 0050 to 0052 update first, confirm it as described [above](#the-update-that-brings-migrations-0050-to-0052), with `Listening on` printed and no `[ERROR] [DB]` or `[CRITICAL] [DB]` line, and leave it running until going back to the previous image is no longer in question. Then deploy this one.

**Before the update**, set up a backup of the uploads folder if there is none: see [Attachment Files](#attachment-files). Until this release a deleted card's files were left on disk for ever. From it on they are removed 30 days after the delete. Files left behind by deletes made before this release stay in their card folders until the release that brings the attachment file sweep (card 2107): its first sweep moves them to the trash, as [below](#the-update-that-brings-migration-0053-one-timestamp-form-and-the-attachment-file-sweep) says.

**After the update**, these confirm it:

| Do | Expect | A fault if |
|----|--------|------------|
| Archive a card that has an attachment and a dependency, then restore it | The attachment opens and the dependency is still shown | Either is gone |
| Permanently delete a card that has an attachment, then look in the uploads folder | The file is in `uploads/.trash/<card id>/`, with a `.trashed-at` file beside it, and the card's own folder is gone if nothing else was in it | The file is still in `uploads/<card id>/`, or is nowhere |
| Attach an HTML file and an SVG file to a card. For each, copy the link address of its name on the card and open that address in a new tab | Each is saved as a download | Either opens as a page |
| Create a card and note its number. Permanently delete it, run Vacuum from the admin panel, then create another card | The new card's number is one more than the deleted card's | The new card has the deleted card's number |

Clicking the attachment on the card is not a check: that link saves the file to disk in the previous release too.

**Going back to the previous image** after this release has run needs nothing done to the database. This release changes no table, so the previous image starts on the database as it is: see [Going Back to the Previous Image](#going-back-to-the-previous-image) for how. Three kinds of activity entry are new: `cards_purged`, `cards_cleared` and `column_deleted`. The previous image has no label for them, as it has none for `card_archived`, which it writes itself, and shows the name in the label's place.

For as long as the previous image runs, it behaves as it did before:

| | Under the previous image |
|---|---|
| The uploads trash | It never reads `uploads/.trash` and never empties it. Files this release moved there stay on disk. Deleting a card leaves its files in `uploads/<card id>/`, and deleting a single attachment removes its file at once |
| Import Backup | It puts no file back from the trash. Move each back by hand, from `uploads/.trash/<card id>/` to `uploads/<card id>/` |
| Attachments | Every attachment is answered inline again, as the type its uploader gave it and with no sandbox. An HTML or SVG attachment opened by its address is a page of the application |
| Vacuum and Reset | Each clears the id counters again. A card or board created afterwards can be given the number of one that was deleted |
| `DELETE /api/v1/cards/{id}?permanent=true` | It deletes the card and then answers `500`. The card is gone. Read before retrying |

What changes for the people who use the installation is in the [Admin Guide](admin-guide.md#danger-zone) and, for API callers, in the [API Reference](api-reference.md#writes-and-failures).

### The Update That Brings the Limits on Report Mail

The release that limits who a mailed report reaches, slows sign-ins after wrong passwords and bounds how deep sub-boards nest and how many cards one drag and drop moves (cards 2182, 2177, 2172 and 2209) brings no migration file and no change to the schema. One thing in it acts on what is already stored: a report schedule that holds more than 10 addresses is switched off at its next due run, sends nothing, and writes one `ERROR` line under `REPORTS` naming it and its owner (see [Who a Report Can Be Mailed To](notifications-email.md#a-schedule-kept-from-before-with-more-than-10)). So, before the update, find any such schedule.

**Before the update**, list each schedule's addresses, read as the scheduler will read them. The image has no `sqlite3` command, so copy the database out into a folder only you can read and run the query read-only on the host. A missing `-wal` file is expected. Copied while the server runs, the copy can be a moment behind; that is enough for this list.

```bash
mkdir -m 700 "$HOME/dumpfire-schedules"
docker cp "<container>:/app/data/dumpfire.db" "$HOME/dumpfire-schedules/"
docker cp "<container>:/app/data/dumpfire.db-wal" "$HOME/dumpfire-schedules/" || echo "No -wal file: expected"
sqlite3 -readonly -header -column "$HOME/dumpfire-schedules/dumpfire.db" < schedules.sql
```

with `schedules.sql` holding:

```sql
WITH RECURSIVE parts(id, rest, part) AS (
  SELECT id, replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(recipients, ';', ','), char(9), ','), char(10), ','), char(11), ','), char(12), ','), char(13), ','), char(32), ','), char(160), ','), char(5760), ','), char(8192), ','), char(8193), ','), char(8194), ','), char(8195), ','), char(8196), ','), char(8197), ','), char(8198), ','), char(8199), ','), char(8200), ','), char(8201), ','), char(8202), ','), char(8232), ','), char(8233), ','), char(8239), ','), char(8287), ','), char(12288), ','), char(65279), ',') || ',', NULL
    FROM report_schedules
  UNION ALL
  SELECT id, substr(rest, instr(rest, ',') + 1), lower(trim(trim(substr(rest, 1, instr(rest, ',') - 1)), '<>'))
    FROM parts WHERE rest <> ''
),
addresses(id, part) AS (
  SELECT id, part FROM parts
   WHERE part LIKE '_%@_%._%' AND part NOT LIKE '%@%@%'
     AND part NOT GLOB '*[<>()",:\[]*' AND part NOT GLOB '*]*'
)
SELECT s.id, s.user_id, s.name, s.enabled,
       COUNT(DISTINCT a.part) AS addresses,
       COUNT(DISTINCT CASE WHEN a.part NOT IN (SELECT lower(email) FROM users) THEN a.part END) AS not_an_account,
       s.recipients
  FROM report_schedules s LEFT JOIN addresses a ON a.id = s.id
 GROUP BY s.id ORDER BY addresses DESC;
```

The rows come largest first. `addresses` is how many the scheduler will send to, `not_an_account` how many of those are no account's email, and `recipients` the schedule's text as stored, so the addresses can be read off it. A word of a display name (`Alice Smith <alice@x.test>`) is not counted, as the scheduler does not send to it. Every character the scheduler reads as a separator is a separator here too (semicolons, commas and every kind of white space, the non-breaking space pasted from a mail program included). The query may count a part holding an invisible control or format character as an address where the scheduler does not, so it can list a schedule as larger than it is, never smaller.

What to do with each row whose `addresses` is above 10:

- **To keep it sending**, its owner deletes it and makes it again as schedules of 10 or fewer, **before the update**. Before it nothing counts what they cost.
- **After the update the same costs addresses.** One account may reach at most 100 addresses with report mail in a 24-hour window counted from its first, and making a schedule takes its addresses from that, so an owner who splits a schedule of 30 into three of 10 afterwards spends 30 of the day's 100 on it, and one of 150 cannot be split in a day.
- **Left as it is**, it is switched off at its next run and its owner finds its addresses on the Reports page, with "Copy the ones to keep into a new schedule of at most 10, then delete this one."
- **Turning a schedule on costs its addresses too**, from the day's 100, and one turned back on keeps the run time it had: if that time passed while it was off (as it has for a schedule this release switched off), it is sent at the scheduler's next tick, within the minute.

```mermaid
flowchart TD
    Query["Query, read-only, on a copy"] --> Row{"Any schedule with<br/>more than 10 addresses?"}
    Row -->|"no"| Deploy["Deploy: nothing is switched off"]
    Row -->|"yes"| Keep{"Is it to keep sending?"}
    Keep -->|"yes"| Remake["Owner remakes it as schedules<br/>of 10 or fewer, before the deploy:<br/>no addresses taken"]
    Keep -->|"no"| Leave["Left: switched off at its next run,<br/>one ERROR line naming its owner,<br/>its addresses on the Reports page"]
    Remake --> Deploy
    Leave --> Deploy
```

**Also before the update**, on the same copy, check that the two limits on a drag and drop are out of reach of real use. A drop on the board page sends the position of every open card on the board, and a request naming more than 5,000 is refused; a request that moves more than 100 cards to another column is refused (`MAX_REORDER_ENTRIES` and `MAX_CARDS_MOVED_AT_ONCE` in `src/lib/server/card-moves.ts`). Run each query as the one above:

```sql
-- The ten boards with the most open cards, and each one's largest column.
SELECT b.id, b.name, COUNT(c.id) AS open_cards, MAX(per_col.n) AS largest_column
  FROM boards b
  JOIN columns col ON col.board_id = b.id
  LEFT JOIN cards c ON c.column_id = col.id AND c.archived_at IS NULL
  LEFT JOIN (SELECT column_id, COUNT(*) AS n FROM cards WHERE archived_at IS NULL GROUP BY column_id) per_col
    ON per_col.column_id = col.id
 GROUP BY b.id ORDER BY open_cards DESC LIMIT 10;

-- The most cards one person moved to another column on one board within one second
-- (a bulk move writes its entries in the same second).
SELECT user_id, board_id, substr(created_at, 1, 19) AS second, COUNT(*) AS moved
  FROM activity_log WHERE action IN ('card_moved', 'card_completed', 'card_reopened')
 GROUP BY user_id, board_id, second ORDER BY moved DESC LIMIT 5;

-- The newest card's id and how many cards there are: no board can hold more.
SELECT MAX(id) AS newest_card_id, COUNT(*) AS cards, SUM(archived_at IS NULL) AS not_archived FROM cards;
```

If the first query's largest `open_cards` is above 2,500, raise `MAX_REORDER_ENTRIES` before building the image; if the second query's top `moved` is above 50, raise `MAX_CARDS_MOVED_AT_ONCE`. Otherwise both limits are far above what the installation does.

**After the update**, nothing needs doing to the database. Going back to the previous image needs nothing either: no table changed, and the previous image sends a schedule this release switched off only once someone turns it on.

### The Update That Brings Password Checks Off the Server's Thread and Remembered Browsers

The release that checks passwords on worker threads (card 2191), checks a name that is no account as slowly as a real one (2192), writes nothing typed into a failed sign-in line (2193), remembers browsers that have signed in and holds every other browser to one sign-in at a time at an account under attack (2194), counts an IPv6 caller by its /64 (2195) and gives back on a successful sign-in only its own account's attempts (2226) brings no migration file, no change to the schema and no change to the image: no new dependency, no native code. One thing in it acts on what is already stored: at its first start it rewrites the failed sign-in lines already in the system log for names that were no account, so that they no longer hold what was typed. Three of the queries below read those lines in their old form. After the first start, `q1.sql` finds 0; `q2.sql` still lists the old bad-password lines but no longer counts the failures at names that were no account; `q3.sql`'s address query still works, but its name query lumps every rewritten line under one name. So **all three are run before the deploy**. The lines as they were stay only in `docker logs` of the old container and in any log shipper's copy, which this release does not touch.

What changes for the people who use it:

- **During a burst of sign-in attempts**, a sign-in from a browser the server does not know waits its turn, about a tenth of a second for each check ahead of it with two threads, and up to a fifth on a host with one or two CPUs, where there is one. When 150 checks for each thread are already waiting it is answered at once "Sign-in is very busy right now. Wait a minute and try again, or sign in from a browser you have used here before." That is about thirty seconds of checks on a fast host, and can be 60 to 90 seconds on a small one: past the 60 seconds nginx waits for an answer by default (`proxy_read_timeout`), so a proxy left at its default answers `504` to whoever was last in the line. The configuration under [Reverse Proxy — Nginx](#reverse-proxy--nginx) sets 86400 seconds for live updates, and does not cut them off. The hands-on step below times one check on production. An invite's form and set-up are treated the same way. Signed-in people and remembered browsers go ahead of them, but never more than three checks in a row while one of theirs waits, and at most five at a time for any one account (plus the new hash of each password change it completes).
- **A browser that signs in, or signs out, is remembered for that account for a year**, by a cookie sent only to the sign-in page, until the account's password is set again. Signing out does not forget it. At the deploy no browser is remembered: **sign in again, or sign out and in, on each browser you will want during an attack, the superadmin's first.**
- **While an account has had five wrong passwords within 15 minutes of each other, browsers not remembered for it are let in one at a time**, and a second at the same moment is refused at once, "A sign-in with this name is already under way from another browser…". This reverses the previous release's "nobody is refused for it". An attack on one account can keep its owner out of every browser not remembered for it for as long as it lasts: see [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out). After an administrator sets a password during an attack, send an invite instead, where mail is set up.
- **The Audit page no longer shows the names people typed that are no account's**: a failed sign-in at one shows only its length, and one at an account names the account and is filed under it. Older lines are rewritten at the first start; backups made before keep them.
- **Everyone on one IPv6 network shares sign-in's ten attempts in 15 minutes**, the request form's limits and the API's count of requests with no key, as an office behind one IPv4 address already does.

**Before the build**, on the host that runs `docker build`, see how many CPUs it has: `docker info --format '{{.NCPU}}'`. The build runs the suite, and with fewer than three the two tests that time real worker threads are skipped (see [The Suite Inside the Image Build](#the-suite-inside-the-image-build)): the build still passes, and the threads are then proved only by the check after the deploy.

**Before the deploy**, on a copy of the database, run the three queries that read the failed sign-in line in its old form. **They must be run before the deploy**: the first start of the new release rewrites the lines they look for. After it `q1.sql` finds 0, `q2.sql` still lists the old bad-password lines but no longer counts the failures at names that were no account, and `q3.sql`'s address query still works but its name query lumps every rewritten line under one name. Copy the database out as for the report schedules above, into a folder only you can read; a missing `-wal` file is expected:

```bash
mkdir -m 700 "$HOME/dumpfire-sign-in"
docker cp "<container>:/app/data/dumpfire.db" "$HOME/dumpfire-sign-in/"
docker cp "<container>:/app/data/dumpfire.db-wal" "$HOME/dumpfire-sign-in/" || echo "No -wal file: expected"
```

The queries hold both kinds of quote, so none of them is run inside double quotes on a command line, where the shell would take the query's own `"` as the end of it. Save each to a file of its own, as `schedules.sql` is above, and run it with:

```bash
sqlite3 -readonly -header -column "$HOME/dumpfire-sign-in/dumpfire.db" < q1.sql
```

or paste it between a quoted heredoc's lines, which the shell leaves exactly as written:

```bash
sqlite3 -readonly -header -column "$HOME/dumpfire-sign-in/dumpfire.db" <<'SQL'
SELECT min(timestamp), max(timestamp) FROM system_logs;
SQL
```

That one says how far back the queries reach: the log keeps its newest 50,000 rows. Every query in this section, these three and the ones after them, is run the same way.

`q1.sql`, the lines the first start will rewrite (keep the count: after the deploy the same query on a new copy should give 0):

```sql
SELECT count(*) AS lines, max(length(message)) AS longest, min(timestamp) AS first
  FROM system_logs
 WHERE message LIKE 'Failed login attempt for "%" from IP %'
   AND message NOT LIKE '% (bad password)';
```

`q2.sql`, addresses with more than ten failed sign-ins in one clock quarter of an hour. Up to twenty can be the edge of a window (a window starts at an address's first attempt, not on the quarter); more than twenty was possible only with a sign-in from the address between them, which this release stops from giving back another account's attempts:

```sql
SELECT replace(substr(message, instr(message, '" from IP ') + 10), ' (bad password)', '') AS address,
       substr(timestamp, 1, 14) || printf('%02d', (CAST(substr(timestamp, 15, 2) AS INTEGER) / 15) * 15) AS quarter,
       count(*) AS failures
  FROM system_logs
 WHERE message LIKE 'Failed login attempt for "%" from IP %'
 GROUP BY address, quarter HAVING failures > 10
 ORDER BY failures DESC LIMIT 20;
```

`q3.sql`, how wrong passwords are spread over addresses and names, if it was not run before the previous release. One address taking nearly every failure means the server reads the proxy's address for everyone (`ADDRESS_HEADER` unset); the second shows how often a real person reaches five in a day:

```sql
SELECT replace(substr(message, instr(message, ' from IP ') + 9), ' (bad password)', '') AS address,
       count(*) AS failures, min(timestamp) AS first, max(timestamp) AS last
  FROM system_logs WHERE message LIKE 'Failed login attempt for %'
 GROUP BY address ORDER BY failures DESC LIMIT 10;

SELECT substr(message, 27, instr(message, '" from IP ') - 27) AS name,
       substr(timestamp, 1, 10) AS day, count(*) AS failures
  FROM system_logs WHERE message LIKE 'Failed login attempt for %'
 GROUP BY name, day ORDER BY failures DESC LIMIT 20;
```

**To know, at any time; nothing waits on them.** How many CPUs the container sees (two worker threads whatever it says, one on one or two CPUs), and how it is told where a caller is (`ADDRESS_HEADER` decides whether IPv6 reaches the counts at all):

```bash
docker exec <container> node -e "console.log(require('node:os').availableParallelism())"
docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.CpusetCpus}}' <container>
docker exec <container> printenv ADDRESS_HEADER XFF_DEPTH HOST
```

If `NanoCpus` is above `0` and at most `2000000000` (a CPU limit of two or fewer, `--cpus=2` or less), set `PASSWORD_THREADS=1`: the count the server reads may be the host's CPUs and not the container's limit, and two threads then share the limit with the server's own thread. `0` is no limit. A setting is added by making the container again, as under [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out).

How long one check takes on production, on the server's CPUs (about half a second of work, with nothing kept). A full line of checks waits 150 times this; above 400 ms, a full line is past the 60 seconds nginx waits for an answer by default:

```bash
docker exec <container> node -e "const b = require('bcryptjs'); const h = b.hashSync('x', 12); const t = Date.now(); b.compareSync('y', h); console.log((Date.now() - t) + ' ms for one check')"
```

The kinds of stored hash. Expect one row, `$2b$12$`: a row with another cost would be accounts whose wrong password takes another time than a name that is no account's.

```sql
SELECT substr(password_hash, 1, 7) AS kind, count(*) AS accounts FROM users GROUP BY kind;
```

What form callers' addresses take. Any `IPv6` row means the /64 changes what production counts; `IPv4 with a port` means every connection has been an allowance of its own:

```sql
SELECT CASE
         WHEN ip IS NULL THEN 'none'
         WHEN ip LIKE '::ffff:%' THEN 'IPv4 written as IPv6'
         WHEN ip GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*:[0-9]*' THEN 'IPv4 with a port'
         WHEN ip GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*' THEN 'IPv4'
         WHEN instr(ip, ':') > 0 THEN 'IPv6'
         ELSE 'other'
       END AS kind,
       count(*) AS lines, count(DISTINCT ip) AS addresses, min(ip) AS example
  FROM system_logs GROUP BY kind ORDER BY lines DESC;
```

How bursty failed sign-ins have been, a minute at a time; a minute with more than a few dozen is a burst that held the server for seconds before this release:

```sql
SELECT substr(timestamp, 1, 16) AS minute, count(*) AS failures
  FROM system_logs WHERE message LIKE 'Failed login attempt%'
 GROUP BY minute ORDER BY failures DESC LIMIT 10;
```

**After the update**, these confirm it. Make a test account `qs-check` with a known password on the admin page first, and delete it at the end.

| Do | Expect | A fault if |
|----|--------|------------|
| Sign in; on the Audit page's logs, filter `AUTH` | No `Password checks cannot run on worker threads (…)` at `ERROR` after the sign-in: that is the proof the threads started. With `LOG_LEVEL` at `INFO` (the default), `Password checks run on 2 worker thread(s)` (or 1) at `INFO` too; it is written at the first check, before any thread starts, so it says what was asked for, not that a thread ran | The `ERROR` line: checks are then on the server's thread, as before, and nobody is kept out by it |
| Time one check with the `bcryptjs` command under "To know" above | Under 400 ms: a full line of 150 checks a thread waits less than nginx's default 60 seconds | Above 400 ms, behind a proxy whose read timeout is 60 seconds: a sign-in at the back of a full line is answered `504` by the proxy before it is checked. The configuration under [Reverse Proxy — Nginx](#reverse-proxy--nginx) waits 86400 seconds and is not affected |
| On the Account page, change your password and change it back | Both work, and you stay signed in | Any error |
| In a browser signed in since before the deploy, sign out; look at its cookies in the developer tools | `dumpfire_known_<your id>`, path `/login`, HttpOnly | None, or path `/` |
| Sign in as `qs-check` | The same cookie for its id | None |
| On the sign-in page, type `qs-check`'s password into the name box and anything as the password; read the newest `AUTH` warning | `Failed login attempt for a name that is no account (N characters) from IP …` | Any of the password in the line |
| A wrong password at `qs-check` | `Failed login attempt at "qs-check" (user <id>) from IP … (bad password)` | The name as typed, or no address |
| `q1.sql` above, on a new copy | `0` lines | Any line left |

Then sign in again, or sign out and in, on every browser you will want during an attack, the superadmin's first, so that each is remembered.

**Going back to the previous image** needs nothing done to the database: no table changed. The previous image ignores the `dumpfire_known_<id>` cookies and checks passwords on the server's thread again; the log lines this release rewrote stay rewritten. It leaves the `known_browser_secret` row in `settings`, and **its backups would hold that row**, since it does not know to take it out: after going back, delete it with the command under [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out). This release makes a new one when it is deployed again, and every browser is remembered again at its next sign-in.

### The Update That Brings the Content-Security-Policy

The release that checks every colour from a request and gives every page a
Content-Security-Policy (card 2162), cleans Markdown one way for descriptions and comments
(2202), serves the Inter font from DumpFire (2203) and draws mentions in text only (2210)
brings no migration file and no change to the schema. Nothing stored is changed. The image
gains seven font files and a licence text; `jsdom`, which only the tests use, is a
development dependency and is pruned from the image with the rest.

```mermaid
flowchart TD
    Before["Before: command 3, SQL 1, SQL 2 and SQL 4"] --> Proxy{"A policy from the proxy,<br/>or scripts it adds?"}
    Proxy -->|"Yes"| Fix["Take them away at the proxy first"]
    Fix --> Before
    Proxy -->|"No"| Trial["Deploy with CSP_MODE=report-only<br/>and walk the pages with the console open"]
    Trial --> Reports{"A report that is not<br/>a browser extension's?"}
    Reports -->|"Yes"| Hold["Keep report-only.<br/>A fix, or a card, first"]
    Hold --> Trial
    Reports -->|"No"| Enforce["Remove CSP_MODE,<br/>make the container again"]
    Enforce --> Done["Pages are protected by the policy"]
```

What changes for the people who use it, and for API callers:

- **Every page loads the font from DumpFire, and no page asks Google, or any other site, for
  anything.** Until now every page, the sign-in page included, loaded Inter from Google's
  font service, which told Google the address of whoever opened DumpFire, and when. The
  files are the ones Google served, byte for byte, so nothing looks different. They are
  fetched once from `/_app/immutable/assets/` and cached for a year; the licence is served
  at `/licences/inter-OFL.txt`.
- **A colour sent to the API is `#rrggbb` or it is refused.** Every operation that takes
  `color` or `colorTag`, in both trees, answers `400` `color must be a colour written #rrggbb`
  (for a colour tag `colorTag must be a colour written #rrggbb, or empty`) for anything
  else, `red` and `#fff` included, where any text was stored. The pages send only
  `#rrggbb`. Through the tracking wrapper, quote the colour, `-Color '#ef4444'`: an unquoted
  `#` begins a PowerShell comment, so `-Color #ef4444` sends nothing and the call stops with
  "Missing an argument for parameter 'Color'".
- **A stored colour that is more than a colour is drawn grey** (`#94a3b8`) until someone
  picks it a colour; every other stored colour looks as it did, one with spaces around it
  included. SQL 1 below lists them. How a grey one is fixed depends on what it colours: a
  label's, a category's, a column's or a board grouping's by picking a colour in its own
  colour picker; a card's or a subtask's colour tag has no control on the page, so only
  through the API, with the wrapper `update-card` or `update-subtask` with
  `-ColorTag '#rrggbb'` or `-ColorTag none` to clear it. Renaming any of them sends the old
  value back unchanged, and it is kept, grey or not.
- **A description or comment is drawn without style, a borrowed class, SVG or MathML, a
  form, a dialog or popover, an image map, a `<template>`, or the `srcset`, `background` and
  `poster` attributes**, and **an image from another site, or from any address on DumpFire
  but a card attachment's, shows as a link** reading 🖼 and its alt text, which opens the
  picture's address.
  Stored text is not changed. SQL 2 and SQL 4 below count what will look different.
- **An email address in a comment is a working link**, and a link's tooltip and an image's
  description no longer show chip markup. A mention inside code or link text is still drawn
  as a chip, because it is still mailed.
- **Pages are protected by the policy only once `CSP_MODE` is removed.** The colour rule and
  the Markdown rules protect them from the first deploy.

**Before the deploy.** The commands in this section are written for Git Bash or the Docker
host's shell, not PowerShell (where `curl` is another command: use `curl.exe`, and the
heredocs below do not work), and the database queries need `sqlite3` installed on that
host. Command 3 reads the public sign-in page and nothing else. Put your own address in
`SITE`:

```bash
SITE=https://dumpfire.example.com
curl -s -D - -o login.html "$SITE/login" | grep -i -E "^(server|cf-ray|content-security-policy)"
grep -c -i -E "cdn-cgi|rocket|cloudflareinsights|data-cf" login.html
grep -c "<script" login.html
grep -c -i -E "fonts\.(googleapis|gstatic)\.com" login.html
```

Expected before the deploy: no `content-security-policy` line, `0`, `2` (the theme script
and SvelteKit's) and `3` (the old font links).

- **A `content-security-policy` line means the proxy sends a policy of its own**, which
  browsers would enforce beside DumpFire's, and which, holding no page's nonce, would stop
  every page's scripts: take it away at the proxy before the deploy. See
  [Security Headers From the Proxy](#security-headers-from-the-proxy).
- **A count above `0` on the second line means the front may put scripts into pages**
  (Cloudflare's Rocket Loader, its automatic Web Analytics beacon). It counts words such as
  `data-cf`, not scripts, so it does not say the policy will refuse anything: read the
  console in the report-only trial below, and turn that feature off only if a report names
  it. **More than two scripts** means one was put in: the trial's console says whether the
  policy refuses it, and the same rule holds.

Then, on a copy of the database, three read-only queries say how much of production each
rule reaches. None changes anything, and nothing waits on their answers. Copy the database
out as for the sign-in queries above, into a folder only you can read; a missing `-wal` file
is expected:

```bash
mkdir -m 700 "$HOME/dumpfire-csp"
docker cp "<container>:/app/data/dumpfire.db" "$HOME/dumpfire-csp/"
docker cp "<container>:/app/data/dumpfire.db-wal" "$HOME/dumpfire-csp/" || echo "No -wal file: expected"
```

Run each by pasting it between a quoted heredoc's lines, which the shell leaves exactly as
written:

```bash
sqlite3 -readonly -header -column "$HOME/dumpfire-csp/dumpfire.db" <<'SQL'
<the query>
SQL
```

**SQL 1: stored colours that are not `#rrggbb`, by table and value, and how each will be
drawn.** Its `CASE` is `isSafeColour` in `src/lib/colours.ts`, written in SQL, on the value
with its leading and trailing spaces, tabs and line breaks trimmed, as `drawnColour` trims
it: the two change together.

```sql
SELECT t, value, n, CASE WHEN v = '' THEN 'no colour' WHEN (v GLOB '#*' AND length(v) IN (4, 5, 7, 9) AND substr(v, 2) NOT GLOB '*[^0-9A-Fa-f]*') OR (length(v) BETWEEN 1 AND 30 AND v NOT GLOB '*[^A-Za-z]*') OR (lower(v) GLOB 'var(--?*)' AND substr(v, 7, length(v) - 7) NOT GLOB '*[^A-Za-z0-9-]*') THEN 'drawn as stored' ELSE 'drawn grey' END AS drawn FROM (SELECT t, value, n, trim(value, char(32, 9, 10, 12, 13)) AS v FROM (SELECT 'labels' AS t, color AS value, COUNT(*) AS n FROM labels GROUP BY color UNION ALL SELECT 'categories', color, COUNT(*) FROM categories GROUP BY color UNION ALL SELECT 'board_categories', color, COUNT(*) FROM board_categories GROUP BY color UNION ALL SELECT 'columns', color, COUNT(*) FROM columns GROUP BY color UNION ALL SELECT 'cards.color_tag', color_tag, COUNT(*) FROM cards WHERE color_tag <> '' GROUP BY color_tag UNION ALL SELECT 'subtasks.color_tag', color_tag, COUNT(*) FROM subtasks WHERE color_tag <> '' GROUP BY color_tag)) WHERE value NOT GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]' ORDER BY t, n DESC
```

No rows: nothing changes on any page, and no stored value was ever more than a colour. A row
"drawn grey": that item shows grey after the deploy; one whose value holds `url(` is
evidence the fault was used. A row "drawn as stored" (`red`, `#fff`): it looks as it does
now, and an API caller that sent it will be refused the next time.

**SQL 2: descriptions and comments with an image, a `<style>` element or a style
attribute.**

```sql
SELECT 'cards' AS t, COUNT(*) AS rows_with_any, SUM(description LIKE '%![%](http%' OR description LIKE '%![%](//%' OR description LIKE '%<img%') AS outside_images, SUM(description LIKE '%<style%') AS style_elements, SUM(description LIKE '% style=%') AS style_attributes FROM cards WHERE description LIKE '%![%' OR description LIKE '%<img%' OR description LIKE '%<style%' OR description LIKE '% style=%' UNION ALL SELECT 'card_comments', COUNT(*), SUM(content LIKE '%![%](http%' OR content LIKE '%![%](//%' OR content LIKE '%<img%'), SUM(content LIKE '%<style%'), SUM(content LIKE '% style=%') FROM card_comments WHERE content LIKE '%![%' OR content LIKE '%<img%' OR content LIKE '%<style%' OR content LIKE '% style=%'
```

`outside_images` counts `<img` of any address, DumpFire's own attachments included: read a
non-zero count row by row.

**SQL 4: stored descriptions and comments that the Markdown rules draw differently.** The
counts are an upper bound: `class=`, `style=`, `<input` and `<label` written as text in a code block count too,
so read a non-zero row by hand.

```sql
SELECT t, COUNT(*) AS rows_with_html_or_images, SUM(body LIKE '%<style%') AS style_elements, SUM(body LIKE '%style=%') AS style_attributes, SUM(body LIKE '%class=%') AS class_attributes, SUM(body LIKE '%<svg%' OR body LIKE '%<math%') AS svg_or_mathml, SUM(body LIKE '%![%](http%' OR body LIKE '%![%](//%' OR body LIKE '%src=%http%' OR body LIKE '%src=%//%') AS outside_images, SUM(body LIKE '%srcset=%' OR body LIKE '%poster=%' OR body LIKE '%background=%') AS other_media_attributes, SUM(body LIKE '%<form%' OR body LIKE '%<input%' OR body LIKE '%<button%' OR body LIKE '%<select%' OR body LIKE '%<textarea%' OR body LIKE '%<label%') AS forms_or_controls FROM (SELECT 'cards' AS t, description AS body FROM cards UNION ALL SELECT 'card_comments', content FROM card_comments) WHERE body LIKE '%<%' OR body LIKE '%![%' GROUP BY t ORDER BY t
```

All zero but `rows_with_html_or_images`: nothing anyone wrote looks different. A non-zero
column: those descriptions or comments are drawn without that feature after the deploy, an
outside image as a link. A non-zero `forms_or_controls`: boxes and controls written as raw
HTML (`<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`, `<label>`) are dropped and
drawn as their text alone; a Markdown task list, `- [ ]` and `- [x]`, keeps its boxes. An
image on DumpFire's own address that is not a card attachment (`![](/api/…)`, `![](x.png)`)
is drawn as a link too, and no column counts it: read the rows with `![` or `<img` by hand.

**The deploy, report-only first.** Start the new image as for any update, with
`-e CSP_MODE=report-only` added to the command it is run with (in Compose, `- CSP_MODE=report-only`
under `environment:`). Then:

1. `docker logs <container> 2>&1` has
   `[WARN] [STARTUP] CSP_MODE=report-only: pages are sent the Content-Security-Policy to report only, not to enforce; remove CSP_MODE once the trial is over. See docs/deployment.md.`
2. Command 3 again: the header line is now `content-security-policy-report-only`, the font
   count is `0`, and the script count is still `2`.
3. With the browser's console open, walk the pages: `/login`; `/`; a board; a card's window,
   its description, its comments and its attachment image; `/all`; `/plan` and a plan, with
   its PDF button; `/burndown`; `/graph`; `/reports`, previewing a PDF; `/admin`; `/audit`,
   whose live log runs; `/account`; `/teams`; `/inbox`; `/archived`; `/docs`; a path that is
   no page; and, signed out, `/request`, an invite link, and a request's confirm and reply
   pages. Choose the dark theme and reload: no flash of the light one. Move a card with the
   board open in a second browser: it moves there within a moment. In the network tab, Inter
   comes from `/_app/immutable/assets/inter-latin-wght-normal-<hash>.woff2` and no request
   goes to any Google host.
4. Preview a report's PDF in every browser family the team uses (Chrome or Edge, Firefox,
   Safari). How a browser's PDF viewer meets the policy differs by family. **If the preview
   fails in one of them, `CSP_MODE` stays `report-only`** and the preview gets its own card;
   the report's Download button is not affected.
5. Use DumpFire as usual for one working day with the console open. Nothing is collected
   from anyone else's browser: the trial is what an open console shows.

**Reading a report.** In report-only mode the console names what the policy would have
refused, beginning `[Report Only]`, and refuses nothing. A report whose source is
`chrome-extension:` or `moz-extension:` comes from a browser extension (a password manager,
a dark-mode extension), not from DumpFire, and does not hold up the next step. Any other
report is either a page the policy breaks, for a build that allows its source, or a script
the front puts into pages, for that feature to be turned off: deal with it before enforcing.

**Then enforce.** Remove `CSP_MODE` and make the container again: `docker restart` cannot
take a setting away, so stop it, remove it (the database and the uploads are on the volume
and stay) and run it with its first command, without the setting; in Compose, take the line
out and run `docker compose up -d`. The start log then has no `CSP_MODE` line, command 3's
header line is `content-security-policy`, and step 3's walk works as before. A policy line
in the console now means something was refused: a fault to report.

**If enforcing breaks a page**, it can be undone without changing the image: set
`CSP_MODE=report-only` again and make the container again the same way (stop, remove, run
with the setting, or put the line back and `docker compose up -d`). The start log has the
`CSP_MODE=report-only` line again and the policy refuses nothing. Once the fault is fixed,
walk step 3 again, then remove the setting as above.

**If an embedded request form is used**, open the page of the other site that frames it: the
form still shows, since the policy has no `frame-ancestors`.

**Going back to the previous image** needs nothing done to the database: no table changed.
The previous image takes any colour again, draws Markdown with DOMPurify's defaults, and
loads the font from Google; it does not read `CSP_MODE`.

### The Update That Brings Migration 0053, One Timestamp Form and the Attachment File Sweep

Three cards go out together: card 2106 brings migration `0053_index_foreign_keys_end_sessions.sql`, which indexes every foreign key column and **signs everybody out once**; card 2095 stores every timestamp in one form and **converts the timestamps production holds**, at the first start; card 2107 **sweeps attachment files that no row names** into the trash, and the first sweep moves a backlog. Each changes what the owner or users see. The review of the three brought migration `0054_index_user_time_end_unused_invites.sql` into the same release: it makes the log's index on `user_id` one on `user_id` and `created_at`, and **ends every invite not yet used, once**. Card 2158's migration 0055, which replaces every request link once, may go out in the same image: see [The Update That Brings Migration 0055](#the-update-that-brings-migration-0055-secrets-out-of-backups-and-request-mail-to-the-accounts-address) for its own checks.

> ⚠️ **0053 must not be deployed before card 2135**, which takes sessions out of backups. Both are in this tree: one image carrying both is fine. An image with 0053 and without card 2135 would let sessions made after the deploy leave in the next backup, and the one sign-out would be spent. The sweep needs card 2007's trash, which is in this tree too.

```mermaid
flowchart TD
    A["0a: measure the timestamps\non an Admin Export copy"] --> C["0c: npm run rehearse on the same copy"]
    B["0b: count the files the first sweep will move,\non the host, read-only"] --> D
    E["0d: list the invites not yet used,\non the host, read-only"] --> D
    C --> D{"Anything in no form,\nor the rehearsal FAILED?"}
    D -->|"Yes"| Rule["Stop. Rule on those values first"]
    D -->|"No"| Deploy["Deploy as in Updating a Running Installation"]
    Deploy --> First["First start: 0053 and 0054 applied, sessions\nand unused invites ended, timestamps\nconverted, one WARN DB line"]
    First --> Resend["Send again the invites from 0d\nthat are still wanted"]
    First --> Sweep["15 minutes later: the first sweep,\none INFO UPLOADS line"]
    Sweep --> After["Checks 1 to 16"]
```

#### Before the deploy: checks 0a, 0b, 0c and 0d

Run all four before the deploy, on a workstation with the new code checked out and on the host. None of them writes anything.

**Check 0a: what form each timestamp column holds on production.** Download a backup with Admin → Export, onto a workstation with the repository checked out, and keep it as secret as the server: it holds every password hash. Save the SQL below as `measure-timestamps.sql` beside it, and run, from the repository folder (so that `better-sqlite3` is found), with the backup's path in place of `<copy.db>`:

```
node -e "const D=require('better-sqlite3');const fs=require('fs');const db=new D(process.argv[1],{readonly:true,fileMustExist:true});console.table(db.prepare(fs.readFileSync(process.argv[2],'utf8')).all())" <copy.db> measure-timestamps.sql
```

The file is opened read-only and must exist; the statement is one `SELECT`. It prints 41 rows, one per column, with zeros for an empty table. `cards.first_completed_at` is left out, because a production database at migration 0049 does not have it yet (0050 fills it from `completed_at`). An export made by the image now on production, from before card 2135, holds the sessions of its day, so the two `sessions` rows count them (one made by this release's image holds none, and they read 0); either way they do not matter, because 0053 ends them all.

```sql
-- Card 2095: which form each timestamp column holds. Read-only: one SELECT, nothing is written.
WITH cols(kind, tbl, col) AS (VALUES
  ('timestamp', 'activity_log', 'created_at'),
  ('timestamp', 'api_keys', 'last_used_at'),
  ('timestamp', 'api_keys', 'expires_at'),
  ('timestamp', 'api_keys', 'created_at'),
  ('timestamp', 'backup_log', 'created_at'),
  ('timestamp', 'board_favourites', 'created_at'),
  ('timestamp', 'boards', 'created_at'),
  ('timestamp', 'boards', 'updated_at'),
  ('timestamp', 'card_attachments', 'created_at'),
  ('timestamp', 'card_comments', 'created_at'),
  ('timestamp', 'card_comments', 'updated_at'),
  ('timestamp', 'card_dependencies', 'created_at'),
  ('timestamp', 'card_templates', 'created_at'),
  ('timestamp', 'cards', 'completed_at'),
  ('timestamp', 'cards', 'archived_at'),
  ('timestamp', 'cards', 'created_at'),
  ('timestamp', 'cards', 'updated_at'),
  ('timestamp', 'invite_tokens', 'expires_at'),
  ('timestamp', 'invite_tokens', 'created_at'),
  ('timestamp', 'milestones', 'created_at'),
  ('timestamp', 'milestones', 'updated_at'),
  ('timestamp', 'report_schedules', 'last_run_at'),
  ('timestamp', 'report_schedules', 'next_run_at'),
  ('timestamp', 'report_schedules', 'created_at'),
  ('timestamp', 'report_schedules', 'updated_at'),
  ('timestamp', 'request_messages', 'created_at'),
  ('timestamp', 'sessions', 'expires_at'),
  ('timestamp', 'sessions', 'created_at'),
  ('timestamp', 'system_logs', 'timestamp'),
  ('timestamp', 'task_requests', 'created_at'),
  ('timestamp', 'task_requests', 'resolved_at'),
  ('timestamp', 'teams', 'created_at'),
  ('timestamp', 'token_usage', 'created_at'),
  ('timestamp', 'users', 'created_at'),
  ('timestamp', 'webhooks', 'created_at'),
  ('timestamp', 'work_dependencies', 'created_at'),
  ('date', 'cards', 'due_date'),
  ('date', 'cards', 'next_recurrence'),
  ('date', 'daily_snapshots', 'date'),
  ('date', 'milestones', 'target_date'),
  ('date', 'subtasks', 'due_date')
),
v(kind, tbl, col, val) AS (
  SELECT 'timestamp', 'activity_log', 'created_at', "created_at" FROM "activity_log"
  UNION ALL SELECT 'timestamp', 'api_keys', 'last_used_at', "last_used_at" FROM "api_keys"
  UNION ALL SELECT 'timestamp', 'api_keys', 'expires_at', "expires_at" FROM "api_keys"
  UNION ALL SELECT 'timestamp', 'api_keys', 'created_at', "created_at" FROM "api_keys"
  UNION ALL SELECT 'timestamp', 'backup_log', 'created_at', "created_at" FROM "backup_log"
  UNION ALL SELECT 'timestamp', 'board_favourites', 'created_at', "created_at" FROM "board_favourites"
  UNION ALL SELECT 'timestamp', 'boards', 'created_at', "created_at" FROM "boards"
  UNION ALL SELECT 'timestamp', 'boards', 'updated_at', "updated_at" FROM "boards"
  UNION ALL SELECT 'timestamp', 'card_attachments', 'created_at', "created_at" FROM "card_attachments"
  UNION ALL SELECT 'timestamp', 'card_comments', 'created_at', "created_at" FROM "card_comments"
  UNION ALL SELECT 'timestamp', 'card_comments', 'updated_at', "updated_at" FROM "card_comments"
  UNION ALL SELECT 'timestamp', 'card_dependencies', 'created_at', "created_at" FROM "card_dependencies"
  UNION ALL SELECT 'timestamp', 'card_templates', 'created_at', "created_at" FROM "card_templates"
  UNION ALL SELECT 'timestamp', 'cards', 'completed_at', "completed_at" FROM "cards"
  UNION ALL SELECT 'timestamp', 'cards', 'archived_at', "archived_at" FROM "cards"
  UNION ALL SELECT 'timestamp', 'cards', 'created_at', "created_at" FROM "cards"
  UNION ALL SELECT 'timestamp', 'cards', 'updated_at', "updated_at" FROM "cards"
  UNION ALL SELECT 'timestamp', 'invite_tokens', 'expires_at', "expires_at" FROM "invite_tokens"
  UNION ALL SELECT 'timestamp', 'invite_tokens', 'created_at', "created_at" FROM "invite_tokens"
  UNION ALL SELECT 'timestamp', 'milestones', 'created_at', "created_at" FROM "milestones"
  UNION ALL SELECT 'timestamp', 'milestones', 'updated_at', "updated_at" FROM "milestones"
  UNION ALL SELECT 'timestamp', 'report_schedules', 'last_run_at', "last_run_at" FROM "report_schedules"
  UNION ALL SELECT 'timestamp', 'report_schedules', 'next_run_at', "next_run_at" FROM "report_schedules"
  UNION ALL SELECT 'timestamp', 'report_schedules', 'created_at', "created_at" FROM "report_schedules"
  UNION ALL SELECT 'timestamp', 'report_schedules', 'updated_at', "updated_at" FROM "report_schedules"
  UNION ALL SELECT 'timestamp', 'request_messages', 'created_at', "created_at" FROM "request_messages"
  UNION ALL SELECT 'timestamp', 'sessions', 'expires_at', "expires_at" FROM "sessions"
  UNION ALL SELECT 'timestamp', 'sessions', 'created_at', "created_at" FROM "sessions"
  UNION ALL SELECT 'timestamp', 'system_logs', 'timestamp', "timestamp" FROM "system_logs"
  UNION ALL SELECT 'timestamp', 'task_requests', 'created_at', "created_at" FROM "task_requests"
  UNION ALL SELECT 'timestamp', 'task_requests', 'resolved_at', "resolved_at" FROM "task_requests"
  UNION ALL SELECT 'timestamp', 'teams', 'created_at', "created_at" FROM "teams"
  UNION ALL SELECT 'timestamp', 'token_usage', 'created_at', "created_at" FROM "token_usage"
  UNION ALL SELECT 'timestamp', 'users', 'created_at', "created_at" FROM "users"
  UNION ALL SELECT 'timestamp', 'webhooks', 'created_at', "created_at" FROM "webhooks"
  UNION ALL SELECT 'timestamp', 'work_dependencies', 'created_at', "created_at" FROM "work_dependencies"
  UNION ALL SELECT 'date', 'cards', 'due_date', "due_date" FROM "cards"
  UNION ALL SELECT 'date', 'cards', 'next_recurrence', "next_recurrence" FROM "cards"
  UNION ALL SELECT 'date', 'daily_snapshots', 'date', "date" FROM "daily_snapshots"
  UNION ALL SELECT 'date', 'milestones', 'target_date', "target_date" FROM "milestones"
  UNION ALL SELECT 'date', 'subtasks', 'due_date', "due_date" FROM "subtasks"
),
f AS (
  SELECT kind, tbl, col, val,
    CASE
      WHEN val IS NULL THEN 'null'
      WHEN typeof(val) <> 'text' THEN 'not_text'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' THEN 'space'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]?*' THEN 'space_more'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' THEN 'iso_ms_z'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z' THEN 'iso_z'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' THEN 'iso_other'
      WHEN val GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN 'date_only'
      ELSE 'neither'
    END AS form
  FROM v
)
SELECT cols.kind, cols.tbl AS "table", cols.col AS "column",
  COUNT(f.form) AS total,
  COALESCE(SUM(f.form = 'null'), 0) AS null_values,
  COALESCE(SUM(f.form = 'space'), 0) AS space_form,
  COALESCE(SUM(f.form = 'iso_ms_z'), 0) AS iso_ms_z,
  COALESCE(SUM(f.form = 'iso_z'), 0) AS iso_z,
  COALESCE(SUM(f.form = 'iso_other'), 0) AS iso_other,
  COALESCE(SUM(f.form = 'space_more'), 0) AS space_more,
  COALESCE(SUM(f.form = 'date_only'), 0) AS date_only,
  COALESCE(SUM(f.form = 'not_text'), 0) AS not_text,
  COALESCE(SUM(f.form = 'neither'), 0) AS neither,
  MIN(CASE WHEN f.form IN ('iso_other', 'space_more', 'not_text', 'neither') THEN f.val END) AS example_unexpected,
  MIN(CASE WHEN f.form = 'space' THEN f.val END) AS first_space,
  MAX(CASE WHEN f.form = 'space' THEN f.val END) AS last_space,
  MIN(CASE WHEN f.form LIKE 'iso%' THEN f.val END) AS first_iso,
  MAX(CASE WHEN f.form LIKE 'iso%' THEN f.val END) AS last_iso
FROM cols LEFT JOIN f ON f.kind = cols.kind AND f.tbl = cols.tbl AND f.col = cols.col
GROUP BY cols.kind, cols.tbl, cols.col
ORDER BY cols.kind DESC, cols.tbl, cols.col;
```

What to read in the result:

| Column of the result | Expected | If not |
|---|---|---|
| `neither`, `not_text`, `space_more`, `iso_other` | 0 everywhere | Each such value is ruled on before the deploy. The new code leaves such a value as it is and reports it at every start; it does not stop the server |
| The 22 columns written by SQL defaults | `space_form` = `total` − `null_values` | ISO 8601 there came from a restore or an import. The first start converts it; nothing to rule |
| The 4 mixed columns (`updated_at` of `cards`, `boards`, `milestones`, `report_schedules`) and the 10 written as ISO 8601 | Any mix of `space_form` and `iso_ms_z` | Nothing to rule: this is what the first start converts |
| The five `date` rows | `date_only` or `null_values` only | A date column holding a timestamp is outside this release: note it and rule on it |

**Check 0b: what the first sweep will move.** On the host, against the live database, read-only: it opens the database read-only and only lists folders.

```bash
docker exec -i dumpfire node - <<'EOF'
const fs = require('fs'), path = require('path');
const dbPath = process.env.DB_PATH || 'dumpfire.db';
const db = require('better-sqlite3')(dbPath, { readonly: true, fileMustExist: true });
const named = new Set(db.prepare('SELECT card_id, filename FROM card_attachments').all().map((r) => (r.card_id + '/' + r.filename).toLowerCase()));
const highest = db.prepare('SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ?), 0), COALESCE((SELECT MAX(id) FROM cards), 0)) AS n').get('cards').n;
const up = path.join(path.dirname(path.resolve(dbPath)), 'uploads');
let files = 0, unnamed = 0, bytes = 0;
const above = [], notCardFolders = [];
for (const d of fs.existsSync(up) ? fs.readdirSync(up) : []) {
  if (d === '.trash') continue;
  if (!/^[1-9][0-9]*$/.test(d) || !fs.lstatSync(path.join(up, d)).isDirectory()) { notCardFolders.push(d); continue; }
  if (Number(d) > highest) { above.push(d); continue; }
  for (const f of fs.readdirSync(path.join(up, d))) {
    const st = fs.lstatSync(path.join(up, d, f));
    if (!st.isFile()) continue;
    files++;
    if (!named.has((d + '/' + f).toLowerCase())) { unnamed++; bytes += st.size; }
  }
}
console.log(files + ' files in card folders; ' + unnamed + ' named by no attachment (' + (bytes / 1048576).toFixed(1) + ' MB)');
console.log('Highest card id this database has issued: ' + highest);
console.log(above.length + ' folder(s) numbered above it: ' + (above.join(', ') || 'none'));
console.log(notCardFolders.length + ' name(s) that are not a card folder: ' + (notCardFolders.join(', ') || 'none'));
EOF
```

The script is fed to `node -` on its standard input (hence `-i`), between `<<'EOF'` and `EOF`: the quotes round the first `EOF` stop the shell reading anything in it, so its `!` and `$` reach Node as written. Inside `node -e "…"`, an interactive bash would read each `!` as a history command and stop with `event not found`.

It prints a count and a size; the highest card id this database has issued, which is the larger of the `cards` counter and the highest id in use, as the sweep reads it; the folders numbered above that id; and the names in the uploads folder that are not a card's folder (`.trash` aside). It reads a card's folder and a named file as the sweep does: a whole number with no leading zero, and a name in any case. It does not leave out a file changed in the last day, which the sweep leaves alone, so the first sweep's count can be a little lower. Every file it counts as named by no attachment is moved to the trash by the first sweep and removed 30 days later, unless an Import Backup puts it back first. If the count is large, take a copy of the uploads folder first ([Backing up and restoring the files](#backing-up-and-restoring-the-files)).

Rule on the two lists before the deploy. The sweep leaves each of them alone and names it in a `WARN` line at every run:

- **A folder numbered above the highest card id** was made by another database, since ids are never used twice: most often a scratch database started beside this one (see [The sweep](#the-sweep-files-no-attachment-names)). Find whose it is, and move it out of `uploads/` if it is not this installation's.
- **A name that is not a card folder** (`notes`, `07`, `.DS_Store`, a stray file) is moved out of `uploads/`, or kept and its `WARN` line accepted. A `lost+found` at the root of a file system mounted at `uploads/` cannot be moved.

**Check 0c: the rehearsal.** `npm run rehearse -- <export.db>`, on the same export, with the new code (see [Testing](testing.md#rehearsing-the-runner-against-a-copy-of-a-real-database)). Expect:

- `Migration files applied` lists `0053_index_foreign_keys_end_sessions.sql` and `0054_index_user_time_end_unused_invites.sql` (and `0055_replace_request_links.sql`, in an image that carries it: see [its section](#the-update-that-brings-migration-0055-secrets-out-of-backups-and-request-mail-to-the-accounts-address)), and `PASSED`.
- `Timestamps converted to the stored form (YYYY-MM-DD HH:MM:SS, UTC): N`, with a line for each column and its count: the conversion the first start will make, measured by the code that will make it. The second run converts none.
- No `Timestamps in no form the conversion can read` lines. Any there is the same finding as a non-zero `neither` in check 0a, and is ruled on before the deploy.
- `The first run took …`: what the first start adds before it listens, index creation and conversion included. Measured in memory, the 39 indexes took 30 ms on 20,000 cards.
- If the export held sessions (one made before card 2135 does), a note under `Worth knowing`: `sessions had N row(s) and has 0: every row deleted by 0053_index_foreign_keys_end_sessions.sql, a one-off declared in tests/rehearsal/one-offs.ts`. That is expected, not a failure.
- If it held invites not yet used (one made before card 2135 does), a note the same way: `invite_tokens had N row(s) and has M: every unused invite deleted by 0054_index_user_time_end_unused_invites.sql, a one-off declared in tests/rehearsal/one-offs.ts`. Expected, not a failure.

It is a fault if it prints `FAILED`, if 0053 or 0054 is not among the files applied, or if a second run converts anything.

**Check 0d: the invites the deploy ends.** On the host, against the live database, read-only. 0054 deletes every invite not yet used, so this lists them, with the account each was for, for you to send again the ones still wanted once the deploy is done:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT u.username, u.email, i.created_at, i.expires_at FROM invite_tokens i JOIN users u ON u.id = i.user_id WHERE i.used = 0 ORDER BY i.created_at').all());
"
```

It prints one row for each invite not yet used, expired or not: the account's name and address, and when the invite was made and when it expires, in UTC. Nothing to rule on: keep the list. An invite whose `expires_at` has passed was dead already. One still to come stops working at the deploy; send it again from User Management (📧) afterwards, which mails the account a new link.

#### What changes at the first start

- **Everybody is signed out, once, the owner included.** 0053's last statement deletes every session. Each browser goes to the sign-in page at its next request. API keys, invites and requesters' links are untouched by 0053 (0054 ends unused invites, and 0055 replaces requesters' links). Until a browser signs in again, each request it makes with its old cookie writes one `[WARN] [AUTH]` line, `Session validation failed — token not in DB (deleted or never issued)`: a few lines a browser, one for each open tab's next call and one for the sign-in page. A later start deletes nothing. Why: [Every Session Ended Once](authentication-security.md#every-session-ended-once-by-migration-0053).
- **Every invite not yet used is ended, once.** 0054's last statement deletes them. A backup made before card 2135 holds every unused invite of its day, and an unused invite sets its account's password until it expires, at most seven days after it was made; ending them all makes the tokens in those copies worthless. Each link then shows the page for a link that no longer works. Send again, from User Management, the invites check 0d listed that are still wanted. Used invites, accounts and API keys are untouched, and a later start deletes nothing. Why: [Every Unused Invite Ended Once](authentication-security.md#every-unused-invite-ended-once-by-migration-0054).
- **39 indexes are created**, one of them as 0054 makes it. It adds little to the first start (30 ms on 20,000 cards, in memory), and a permanent delete of a large board takes milliseconds instead of seconds (48 ms against 9.4 s, measured on a board of 2,000 cards).
- **A person's log entries are indexed by person and time.** 0054 drops 0053's index on `activity_log.user_id` and creates one on `user_id` and `created_at`. The audit routes filtered by a person (`/api/audit`, `/api/v1/audit-log`) read that person's newest entries straight from it and stop at the page, where they sorted every entry of the person's (with a board or a card filtered as well, they read that board's or card's entries by its own index instead); `/api/v1/me/stats` reads only the last 7 or 30 days of them. The activity report filtered by a person looks each card's entries and comments up by card: with an index on `user_id`, SQLite had read every entry of the person's once for each card (4,215 ms against 9 ms on 2,000 cards and 60,000 entries). No answer changes.
- **Timestamps are converted.** The values of up to 16 columns are rewritten to `YYYY-MM-DD HH:MM:SS` in UTC, each naming the same moment to the second, and one `[WARN] [DB] N timestamp(s) converted to the stored form …` line names each column and its count. API callers see every timestamp in ISO 8601 with `Z` from now on: see the [API Reference](api-reference.md#timestamps).
- **The first sweep**, 15 minutes after the first start where the schedulers run, moves every file left by permanent deletes made before card 2007, and any other file no row names that is more than a day old, to `uploads/.trash/`, and says so in one `[INFO] [UPLOADS]` line. They are removed 30 days later.

#### After the deploy

| # | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|
| 1 | Open DumpFire in a browser that was signed in | Any account | The sign-in page; signing in works | Still signed in, or signing in fails |
| 2 | Call `GET /api/v1/me` with an existing API key | A key made before the deploy | `200` | `401` |
| 2b | Open the link of an invite sent before the deploy and not yet used | Any invite check 0d listed | The page for a link that no longer works; a new invite sent from User Management works | The old link sets a password |
| 3 | Read the start's log | Host | `Applied migration: 0053_index_foreign_keys_end_sessions.sql` and `Applied migration: 0054_index_user_time_end_unused_invites.sql`; no `[ERROR] [DB]` line | Any `[ERROR] [DB]` (the indexes differ from the model, or a timestamp could not be read) |
| 4 | On a copy, permanently delete the largest board | The superadmin on an instance that is not production | It is gone within about a second | Several seconds, the page waiting |
| 5 | Read the first start's log, then restart and read it again | Host | First: one `[WARN] [DB]` line naming the columns converted and their counts. Second: none | A line at the second start, or an `ERROR` naming values it cannot read |
| 6 | Open a board's archive panel | An editor; a board with an archived card | "Archived 14 Oct" | "Archived Invalid Date" |
| 7 | On the dashboard, sort boards by last activity, after editing a card on the board that was last | Any user | That board first, with "just now" | Another order, or a wrong time |
| 8 | `GET /api/v1/cards/{id}` for a completed card | API key | `completedAt`, `createdAt` and `updatedAt` in the form `YYYY-MM-DDTHH:MM:SS.000Z` | Any of them `YYYY-MM-DD HH:MM:SS` |
| 8b | Export a board as CSV and open it in a spreadsheet | An editor | "Created" and "Completed" as `YYYY-MM-DD HH:MM:SS` (UTC), opened as dates | A `T` or a `Z`, or text the spreadsheet does not read as a date |
| 9 | Reports page, a custom range with today as both start and end | Any user; a card created and one completed today | Both counted | Either missing |
| 10 | Audit page, from today to today | An administrator | Today's entries, the last minute's included | Missing entries |
| 11 | Account page, the API key list | Any user with a key | "Created" shows the right day; "Last used" a time just past | A day off, or Invalid Date |
| 12 | `GET /api/v1/audit-log?from=yesterday` (literally the word) | API key | `400` naming `from` | `200` |
| 13 | On an instance that is not production, Import Backup of a backup taken before the deploy, then restart | The superadmin | One `[WARN] [IMPORT] N timestamp(s) the backup held in another form were converted …` line after the import; no conversion line at the restart | A line at the restart |
| 14 | On a test instance with data of its own (not a copy of production), started with `SCHEDULERS=on`: put `stray.txt` in `uploads/<id of an existing card>/` and age it with `touch -d '2 days ago'`; put `fresh.txt` beside it; put another aged `stray.txt` in `uploads/0<id>/`; restart; wait 16 minutes | Host; a card with an attachment | The first `stray.txt` in `uploads/.trash/<id>/` with `.trashed-at`; `fresh.txt` still there; the one in `0<id>` still there, named in a `WARN` line; one `[INFO] [UPLOADS]` line; the card's real attachment still opens | A `stray.txt` moved that should not be, `fresh.txt` gone, or the attachment broken |
| 15 | The same with `SCHEDULERS=off` | Host | After 16 minutes `stray.txt` is still there and there is no sweep line | It moved |
| 16 | After the deploy, wait 16 minutes and read the log | Host | One `[INFO] [UPLOADS] Moved N attachment file(s) …` line whose count is near check 0b's | A count far above it, or a `WARN` about other databases' folders |

Every container started from a copy of production for these uses `--network none` and `SCHEDULERS=off`, as [the rehearsal](#rehearsing-an-update-against-a-copy) says, and the copy is treated as secret.

#### Going back to the previous image

Nothing is done to the database: start the previous image on it as it is ([Going Back to the Previous Image](#going-back-to-the-previous-image)).

- **0053 and 0054 stay applied.** An image with the runner logs one `[ERROR] [DB]` line for the two recorded files it has no file for, and one for the 39 indexes its model lacks, 0054's among them, and starts. Nobody is signed out a second time, and no invite is ended a second time: one sent after the deploy keeps working.
- **Timestamps.** The older image compares the stored form with its own ISO 8601 "now" as text, and a value in the stored form sorts before every ISO 8601 time of the same day, because a space sorts before `T`. So:
  - a session, an invite or an API key whose expiry falls on the current UTC day counts as expired from 00:00 that day;
  - each scheduled report is sent early on its due day, just after 00:00 UTC, once: its next run, in the stored form, is due from midnight, and the next run it then writes is ISO 8601 and falls due on time;
  - its log pruning deletes the rows of the cutoff day early, all of that day at once, since every stored row of that day sorts before its ISO cutoff;
  - its reports have the date faults this release fixed.

  It writes ISO 8601 again. The next start of the newer image converts what it wrote, with one `[WARN] [DB]` line.
- **The sweep** stops with the newer image. Files it moved stay in the trash, which an image from before card 2007 never reads or empties: see [The Update That Brings Transactions and the Uploads Trash](#the-update-that-brings-transactions-and-the-uploads-trash).

### The Update That Brings Migration 0055, Secrets Out of Backups and Request Mail to the Account's Address

Three cards go out in one image, and this is the one note for them.

- **Card 2158** brings migration `0055_replace_request_links.sql`, which **replaces every task request's link once**, and changes what a backup holds and what a restore does: a backup holds no request link and not the key the public request form signs with, and every restore gives every request a new link. A requester whose link no longer works asks for the current one from the page it opens. If it goes out in the same image as [migration 0053](#the-update-that-brings-migration-0053-one-timestamp-form-and-the-attachment-file-sweep), everybody is signed out and every request link is replaced on that one deploy.
- **Card 2169** takes the mail password, every backup destination's credentials and every webhook's signing secret out of every backup, and seals every backup with a key the server keeps. A restore keeps this server's own where they are for the same account, only into a backup this server made and nobody has changed since, and lists any to enter again; a scheduled backup does not try a destination that lacks its credentials; and the server says at every start what is still to enter. No migration. The one thing written to the running database is the key, a `backup_seal_key` setting the first backup after the deploy makes: mail, backups and webhooks go on as they are.
- **Card 2171** sends every mail to a requester who made the request while signed in to the account's email as it is when the mail is sent, not the address stored when the request was made, and the inbox shows that address. Deleting an account writes its email onto its requests first. No migration.

> ⚠️ **Never card 2158 without card 2171.** The new route that mails a requester the current link (`POST /api/requests/[id]/link`) would otherwise compare the address given with the one stored when the request was made. For a request made while signed in, whose account's email has changed since, whoever holds the old mailbox could have the thread's link mailed there whenever they liked. Card 2171 makes the route, and every other mail to a requester, use the account's address as it is now. An image carrying both is fine; one with card 2158 and without card 2171 is not to be deployed.

```mermaid
flowchart TD
    G["0g: which secrets production holds,<br/>on the host, read-only"] --> Deploy
    H["0h: whose request mail changes address,<br/>on the host, read-only"] --> Deploy
    E["0e: count the requests and see that mail is set up,<br/>on the host, read-only"] --> R["0c: the rehearsal lists 0055,<br/>and notes the links it replaced"]
    K["0f: make a request to yourself,<br/>confirm it, keep the reply mail"] --> Deploy
    R --> Deploy["Deploy as in Updating a Running Installation"]
    Deploy --> First["First start: 0055 applied,<br/>every request link replaced"]
    First --> After["Checks 17 to 21, then 22 to 37"]
```

#### Before the deploy: checks 0e to 0h

**Check 0e: who will meet a dead link, and whether they can be sent a new one.** On the host, against the live database, read-only. It prints no token, no key and no credential, the backup destinations by type and name only, and it holds no `!` or `$`:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT status, COUNT(*) AS requests, SUM(requester_email IS NOT NULL) AS with_email, MAX(created_at) AS newest FROM task_requests GROUP BY status ORDER BY status').all());
const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_config');
const c = row ? JSON.parse(row.value) : {};
console.log('backup schedule:', c.schedule || 'none', '| destinations:', (c.destinations || []).map((d) => d.type + ' ' + d.name).join(', ') || 'none');
console.table(db.prepare('SELECT destination_type, status, COUNT(*) AS runs, MIN(created_at) AS first, MAX(created_at) AS last FROM backup_log GROUP BY destination_type, status').all());
console.log('mail set up:', Boolean((db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp_host') || {}).value));
db.close();
"
```

Each request counted has a link that stops working at the deploy. A requester who opens one is asked for the address the request was made with, and the current link is mailed there, so **mail must be set up** (`mail set up: true`) for anyone to be sent one; with none, set it up before the deploy. `backup_log` keeps the last ten runs, so an empty table does not prove that no copy ever left: the replacement does not depend on it.

**Check 0f: a link to try afterwards.** In a private window, make a request on `/request` to yourself, with a second `+` alias of a mailbox you can read as its address, and confirm it from the mail. Then, signed in as yourself, reply to it in the Inbox, and keep the reply mail: its "View & Reply" opens the thread now, and check 17 opens it after the deploy.

**Check 0g: which secrets production holds, and what a restore elsewhere would ask for** (card 2169). On the host, against the live database, read-only. It prints flags, counts, the mail port and "Use SSL/TLS" setting (neither is secret) and the destinations by type and name, never a secret, and it holds no `!` or `$`:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
const has = (v) => Boolean(v && String(v).length > 0);
console.log('mail: host set', has(get('smtp_host')), '| port', get('smtp_port'), '| secure', get('smtp_secure'), '| user set', has(get('smtp_user')), '| password set', has(get('smtp_pass')));
let c = {};
try { c = JSON.parse(get('backup_config') || '{}'); } catch (e) { console.log('backup_config is not JSON'); }
for (const d of (c.destinations || [])) { let sa = {}; try { sa = JSON.parse(d.serviceAccountJson || '{}'); } catch (e) {} console.log('destination', d.type, JSON.stringify(d.name), '| password', has(d.password), '| private key', has(d.privateKey), '| S3 secret', has(d.secretAccessKey), '| client secret', has(d.clientSecret), '| refresh token', has(d.refreshToken), '| service account key', has(sa.private_key)); }
console.table(db.prepare('SELECT active, length(secret) > 0 AS signed, COUNT(*) AS webhooks FROM webhooks GROUP BY 1, 2 ORDER BY 1, 2').all());
console.table(db.prepare('SELECT destination_type, status, COUNT(*) AS runs, MIN(created_at) AS first, MAX(created_at) AS last FROM backup_log GROUP BY destination_type, status').all());
db.close();
"
```

Read it for three things. What is `true` there is what a restore of a backup onto another server, or a server rebuilt from one, would ask to be entered again: have each of those, and each webhook receiver's secret, somewhere outside DumpFire before the deploy (see [Backup Destinations](#backup-destinations)). An SFTP destination with `password false` and `private key false` whose recent runs succeed is one whose server accepts no password at all; it goes on being tried as it is (it is not stopped as "credentials are not entered"). And `port 587` (or 25) with `secure` empty or `false` is mail sent with the certificate not checked: that is a card of its own, and not changed by this release. `backup_log` keeps the last ten runs, so it cannot show that no copy ever left the server: every copy made before this deploy holds the secrets, as below.

**Check 0h: whose request mail changes address at the deploy** (card 2171). On the host, read-only; it prints counts, never an address:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT tr.status, COUNT(*) AS made_signed_in, SUM(lower(trim(tr.requester_email)) <> lower(u.email)) AS address_since_changed FROM task_requests tr JOIN users u ON u.id = tr.requester_user_id GROUP BY tr.status ORDER BY tr.status').all());
console.table(db.prepare('SELECT status, COUNT(*) AS requests, SUM(requester_email IS NOT NULL) AS with_address FROM task_requests WHERE requester_user_id IS NULL GROUP BY status ORDER BY status').all());
db.close();
"
```

`address_since_changed` is how many requests made signed in are mailed at a different address from the deploy on: the account's address as it is now. The second table is the requests made without an account, or whose account was deleted before the deploy, which keep the address stored on them.

**In the rehearsal (check 0c)**, `Migration files applied` lists `0055_replace_request_links.sql` too, and, for an export that holds requests, a note under `Worth knowing`: `task_requests: every access_token replaced in its N row(s) by 0055_replace_request_links.sql, a one-off declared in tests/rehearsal/one-offs.ts`. Expected, not a failure. The rehearsal still fails if `task_requests` loses a row.

#### What changes at the first start

- **Every request link mailed before the deploy stops working, once.** 0055's one statement gives every request a new token, open, settled or unconfirmed. Copies of backups made before this, at a destination or downloaded, hold every link as it was mailed; replacing them all makes those copies open no thread. A later start replaces nothing. Why: [Every Request Link Replaced Once](authentication-security.md#every-request-link-replaced-once-by-migration-0055).
- **The page an old link opens** says "This link no longer works. Enter the email address you made the request with (if you made it while signed in to DumpFire, your account's email address as it is now), and a new link will be sent to it.", with an address field and "Send me a new link"; the confirm page shows the same under its refusal. Whatever is entered, the answer is the same sentence; only the request's address is sent the link (for a request made signed in, the account's email as it is now), at most three times an hour, and the reply page no longer asks the server every five seconds for a thread it cannot open.
- **Backups made from now on hold no request link** and not the request form's key, and **every Import Backup replaces every request's link**: its answer says how many, and the requesters of those links ask for new ones the same way.
- **Backups made from now on hold no mail password, no destination credential and no webhook secret**, and a webhook that has a secret is switched off in them (card 2169). The running server is not changed: its mail, its backups and its webhooks work as before, and Backup History shows the next run succeed at every destination. An Import Backup keeps this server's secrets for the same accounts, and its result lists any to enter again. **Every backup is sealed** from now on: a `backup_seal` setting in the file, the seal's form number `2:` and an HMAC of every row made with the `backup_seal_key` the first backup makes in the running database, which no backup holds. Import Backup fills this server's secrets only into a backup whose seal it makes again with its own key: one made by another server, or changed since in anything a restore brings in, has every gap listed, and its "To enter again" line ends "None was kept from this server, because this backup was not made by this server, or was changed since." The seal covers the file's whole structure, SQLite's own objects and the statistics ANALYZE writes included, and the import reads every table's rows as stored (`NOT INDEXED`), the rows the seal was made over. Before the seal is asked, a file that fails `PRAGMA integrity_check`, or holds an object named as SQLite's own that no backup of this server's holds, is treated as changed: the restore goes ahead, nothing is filled, and the import writes one `[WARN] [IMPORT]` line beginning "Nothing was kept from this server, because the backup failed a check made before its seal is checked" that names the check. **Copies made before this deploy carry no seal**: restoring one fills nothing from this server, which changes nothing, since they hold their own secrets; a line with anything to enter would end "None was kept from this server, because this backup carries no seal this server can check." Sealing adds about 0.2 s to a backup of a 59 MB database (0.56 s at 177 MB, measured on a development machine), and verifying as much to an import, with about 0.12 s more for the integrity check. Nothing new is written at start on production, where every secret is entered; a `[WARN] [STARTUP]` line beginning "To enter again, because a backup does not hold them" would mean something already lacks one.
- **Every mail to a requester who made the request signed in goes to the account's email as it is now** (card 2171): the team's reply, "Request accepted", "Request declined", the progress and completion mails, and a new link. The inbox shows that address. Check 0h counted the requests this changes. Deleting a user writes the account's email onto every request it made, so its requests go on being mailed at its last address.
- Requests, their messages and the inbox are otherwise untouched, and the team sees nothing new.

**Owner to know.** From this deploy on a backup is not enough to rebuild a lost server: restored anywhere but the server it came from, or put in place by hand, it needs the mail password, every destination's credentials and every webhook's secret entered again (see [Backup Destinations](#backup-destinations)). Restored on the server it came from it needs nothing entered, as long as it is the file that server made, unchanged: a restore keeps nothing from this server for a backup changed since, by anyone, in anything a restore brings in, its structure, SQLite's own objects and statistics included, nor for a file that fails SQLite's integrity check. The seal leaves out only what a restore never brings in (the hidden rowids of a table with no `INTEGER PRIMARY KEY`, though not their order; `sqlite_sequence`; the file's header and free space), so a change there restores nothing different. Copies made before this deploy still hold them, and carry no seal, and nothing can take them out: they go as each destination's retention removes them. If one of them may have been read by somebody who should not have, change the mail password and each destination's credentials at their services and enter them again, and set new webhook secrets with their receivers.

#### After the deploy

| # | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|
| 17 | Open the reply mail kept in check 0f | A private window | "This link no longer works" and the address field | The thread |
| 18 | Enter a wrong address; then the right one | | The same sentence both times; one mail, for the right one, whose link opens the thread | A different answer for the wrong one, no mail, or two |
| 19 | Leave a page from check 17 open for a minute, then read Admin, Logs | The superadmin | At most a line or two for that request | A line every five seconds |
| 20 | Export a backup. Search the file for the token in check 18's link, and for `request_form_secret` | The superadmin | Neither found | Either found |
| 21 | On an instance that is not production, Import Backup of that export **as a working copy**; open check 18's link with its address changed to that instance's, and ask for a new link | That instance's superadmin | The import's answer, and the report on the page, say how many request links were replaced; the link no longer works; the ask is answered "New links cannot be sent just now. Please contact the team that sent you the link.", and that instance's log has a `[WARN] [REQUESTS]` line saying mail is not set up (unless that instance's own test mail was set up first) | The link opens the thread, or the import restored as it is |

Checks 22 to 24 and 31 to 37 run on production. **Checks 25 to 30 restore a backup, so they run on an instance that is not production, with a database of its own**: a fresh data volume, set up with a superadmin of its own and no mail settings or destinations, started with `--network none` and `SCHEDULERS=off` as in [Rehearsing an Update Against a Copy](#rehearsing-an-update-against-a-copy). Never on production, and never on a copy of production's live database: the restore would rightly keep that copy's secrets, and the checks would show nothing. Importing production's export there signs you out; sign in again as production's superadmin. The instance is never given a network afterwards: the restore "as it is" brings production's unsigned webhooks and report schedules back on there. Checks 31 to 37 use a throwaway ordinary account, `rq-check`, made for them, with a password you know and an email that is a `+` alias of a mailbox you can read; mail must be set up and an App URL set. Delete `rq-check`, its request and its card at the end.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 22 | 2169 | Export Backup, save it in the repository folder on a workstation as `dumpfire-export.db`, and run check 0g's command on it from that folder, as below | The superadmin | The mail line's "password set" is `false`; on every destination line "password", "private key", "S3 secret", "client secret", "refresh token" and "service account key" are `false`; every webhook row is `signed 0`, and those that were signed in 0g are `active 0`; "left out:" lists them; and `sealed: true`, `seal key in it: false` | Any of them `true`, or `sealed: false` |
| 23 | 2169 | Admin, ☁️ Scheduled Backups, ▶ Run Now | The superadmin | Success at every destination: the running server keeps its credentials | "credentials are not entered", or any new failure |
| 24 | 2169 | Admin, 📧 Email / SMTP, 🧪 Send Test | The superadmin | It arrives | It fails |
| 25 | 2169 | On the instance, Import Backup of check 22's file, "Restore everything as it is" | That instance's superadmin | The result's "To enter again" line names the mail password, each destination by name with what it needs, and each signed webhook with its board, and ends "None was kept from this server, because this backup was not made by this server, or was changed since." (production's backup, another server's key), or, where the instance has never taken a backup and so has no key, "None was kept from this server, because this backup carries no seal this server can check." The mail panel's password is empty; each destination's Edit shows its secret fields empty; a Google Drive OAuth destination shows Connect | No such line, or a secret present |
| 26 | 2169 | Straight after, restart the instance and read its log | | One `[WARN] [STARTUP]` line naming the mail password, each destination with what it needs but an SFTP one, and each signed webhook with its board; and, from the import, one `WARN` line with the same list and an SFTP destination too, which the start-up line leaves out | The webhooks missing from either line |
| 27 | 2169 | On it, ▶ Run Now | | Backup History shows each destination failed with "This destination's credentials are not entered…", at once (an SFTP destination is tried, and fails to connect with no network) | A connection or authentication error at an S3, Drive or OneDrive destination |
| 28 | 2169 | On it, type a made-up mail password and save; export; Import Backup of that export as it is | | The result says "Kept from this server, because a backup does not hold them: the mail password"; the mail panel shows the password as set | The mail password listed to enter again |
| 28a | 2169 | On a workstation, in the repository folder, change one card's title in that export as below; on the instance, Import Backup of the changed file as it is | | The result's "To enter again" line names the mail password and ends "None was kept from this server, because this backup was not made by this server, or was changed since."; the mail panel's password is empty | "Kept from this server" |
| 29 | 2169 | On it, Import Backup of check 22's file as a working copy; then restart it | | The working-copy sentence counts as switched off every webhook production had on, signed or not, and one mail setting fewer removed than before this change (no password); a "To enter again" line names only the signed webhooks; after the restart, no start-up line names a webhook | The mail password or a destination listed, or "0 webhook(s) switched off" where production had webhooks on |
| 30 | 2169 | On it, by hand: stop it, put check 22's file in place as its database (deleting `-wal` and `-shm`), start it; read its log | | One `[WARN] [STARTUP]` line naming the mail password, each destination but an SFTP one (which is tried as before, and named by no start-up line), and each signed webhook | No line |
| 31 | 2171 | Sign in as `rq-check` in a private window; make a request on `/request` addressed to yourself | `rq-check` | Made, with no confirmation step | |
| 32 | 2171 | In that window, Account, change `rq-check`'s email to a second alias | `rq-check`'s password | Changed | |
| 33 | 2171 | As yourself, open Inbox | Yourself | The request shows the second alias | The first alias |
| 34 | 2171 | Reply in the Inbox; then accept the request into a board and comment on its card | Yourself | The reply, "Request accepted" and the comment's progress mail arrive at the second alias, and nothing at the first | Any at the first alias |
| 35 | 2171 | In another private window open `/request/<id>/reply?token=x`; enter the first alias; then the second | No account | The words "…(if you made it while signed in to DumpFire, your account's email address as it is now)…"; the same sentence both times; one mail, at the second alias, whose link opens the thread | A mail at the first alias, or a different answer |
| 36 | 2171 | Delete `rq-check`; comment on the card again | The superadmin | The progress mail arrives at the second alias | At the first alias, or none |
| 37 | 2171 | In a private window, make a request on `/request` with a third alias, confirm it from the mail, then reply to it from the Inbox | No account, then yourself | Both mails at the third alias, as before | Anything changed |

Check 22's command is check 0g's with `docker exec dumpfire` taken off, the file's path as its argument, and two lines more. Save the export in the repository folder as `dumpfire-export.db` and run it from that folder, so that `better-sqlite3` is found and the plain relative path `./dumpfire-export.db` names the file in PowerShell 5.1 as well as in a POSIX shell. Write it with a forward slash: PowerShell takes either, but a POSIX shell reads `.\dumpfire-export.db` as `.dumpfire-export.db`, another file, and a path that begins with `~` is not expanded for a program in PowerShell 5.1. It prints flags only:

```bash
node -e "
const db = require('better-sqlite3')(process.argv[1], { readonly: true, fileMustExist: true });
const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
const has = (v) => Boolean(v && String(v).length > 0);
console.log('mail: host set', has(get('smtp_host')), '| port', get('smtp_port'), '| secure', get('smtp_secure'), '| user set', has(get('smtp_user')), '| password set', has(get('smtp_pass')));
let c = {};
try { c = JSON.parse(get('backup_config') || '{}'); } catch (e) { console.log('backup_config is not JSON'); }
for (const d of (c.destinations || [])) { let sa = {}; try { sa = JSON.parse(d.serviceAccountJson || '{}'); } catch (e) {} console.log('destination', d.type, JSON.stringify(d.name), '| password', has(d.password), '| private key', has(d.privateKey), '| S3 secret', has(d.secretAccessKey), '| client secret', has(d.clientSecret), '| refresh token', has(d.refreshToken), '| service account key', has(sa.private_key)); }
console.table(db.prepare('SELECT active, length(secret) > 0 AS signed, COUNT(*) AS webhooks FROM webhooks GROUP BY 1, 2 ORDER BY 1, 2').all());
console.log('left out:', get('webhook_secrets_left_out'));
console.log('sealed:', has(get('backup_seal')), '| seal key in it:', has(get('backup_seal_key')));
db.close();
" ./dumpfire-export.db
```

Check 28a's change, on the export check 28 made, saved in the repository folder as `dumpfire-export-28.db`; it copies the file and changes the copy, `dumpfire-export-28-changed.db`, which is the one to import:

```bash
node -e "
require('fs').copyFileSync(process.argv[1], process.argv[2]);
const db = require('better-sqlite3')(process.argv[2], { fileMustExist: true });
console.log('cards changed:', db.prepare('UPDATE cards SET title = title || ? WHERE id = (SELECT MIN(id) FROM cards)').run(' (changed)').changes);
db.close();
" ./dumpfire-export-28.db ./dumpfire-export-28-changed.db
```

#### Going back to the previous image

Nothing is done to the database but the one row below, deleted with the container stopped before the older image starts.

- **0055 stays applied.** An older image with the runner logs one `[ERROR] [DB]` line for the recorded files it has no file for, 0055 among them, and starts. No link is replaced a second time.
- **The new route goes with it.** An old link's page says "This link is no longer valid. Use the link in the most recent email about your request." again, and polls; a requester can then be sent a new link only by the team's next reply.
- **Backups made by the newer image** hold no links; restored by the older image, or put in place by hand, every request is given one by the start's backfill. The older image's own backups hold links again.
- **The seal's key stays in the running database, and the older image does not know to leave it out of a backup.** Delete it with the container stopped, after the newer image's last start and before the older image's first, so that no copy the older image makes holds it: a one-off container on the same volume, from the newer image (any image that has `better-sqlite3` will do), writes to the database file while nothing else has it open. Going forward again, the newer image makes a new key, and its backups made before then are restored with every gap listed:

  ```bash
  docker stop dumpfire
  docker run --rm --network none -v dumpfire-data:/app/data dumpfire:latest node -e "
  const db = require('better-sqlite3')('/app/data/dumpfire.db', { fileMustExist: true });
  console.log('keys removed:', db.prepare('DELETE FROM settings WHERE key = ?').run('backup_seal_key').changes);
  db.close();
  "
  ```

  It prints `keys removed: 1` (or `0` where no backup was taken since the deploy). Then start the older image as above. For a container, a volume or a `DB_PATH` other than the [Production](#production) command's, put those in place of `dumpfire` (after `docker stop`), `dumpfire-data` and `/app/data/dumpfire.db`: under Docker Compose the container is not called `dumpfire` unless the compose file sets `container_name`, so take its name from `docker compose ps` (such as `dumpfire-dumpfire-1`), and the volume is `<project>_dumpfire-data`.

- **Backups made by the newer image hold no secret.** Imported into the older image, they come up with no mail password, no destination credentials and their signed webhooks off, and the older image says nothing of it: enter them as in [Restoring from Backup](admin-guide.md#restoring-from-backup), step 5. The running database's own secrets are not touched by going back, and the older image's backups hold them again.
- **Request mail goes back to the address stored on each request.** The addresses `deleteUser` wrote for accounts deleted meanwhile stay, and are the accounts' last.

### The Update That Checks the Mail Server's Certificate

Four cards and one upgrade go out in one image, and this is the one note for them. No migration and no schema change.

- **Card 2189** sends every mail over a checked, encrypted connection: port 465 TLS from the first byte, any other port STARTTLS required, and on every port the certificate checked for the host's name. The "Use SSL/TLS" box is gone (its `smtp_secure` row is left and no longer read), and "Allow mail without a checked, encrypted connection" is the one way out, a new `smtp_allow_insecure` row written when the panel first saves it. See [Mail Server Certificates](#mail-server-certificates). **Mail stops at the deploy** if production's mail server cannot give such a connection: run checks 0i and 0k first.
- **Card 2190** keeps a saved secret only for the settings it was saved with: the mail password only while the host, port, user name and the way out are as saved; a backup destination's secret only for the one saved destination that is the same in type, name and every setting that is not secret. Otherwise a save or a test is refused, `400`, naming what to type again.
- **Card 2187** masks every backup destination secret in the admin page's answer, the Google Drive refresh token included, which it carried as stored; one list of secret fields serves the answer, the save and the test.
- **Card 2188** has Google Drive asked for `drive.file` (DumpFire's own files) in place of the whole of Drive. Connections made before keep working, with the whole of Drive, until narrowed by hand (below). Connect makes a folder of its own for a destination with no Folder ID, checks one that is set, and records the scope Google granted; the row shows `⚠️ Connected · all of Drive` for every connection made before.
- **Card 2227's nodemailer upgrade**: nodemailer 8.0.7 to 10.1.1, which needs Node 20 or newer (the image is `node:22-slim`). See [the SBOM analysis](sbom-analysis.md).

```mermaid
flowchart TD
    I["0i: the mail server checked<br/>from the running container"] --> Pass{"PASS, or way out set?"}
    Pass -->|"yes"| Build["Build the new image"]
    Pass -->|"no: no STARTTLS, or a name<br/>not on the certificate"| Fix["Before the deploy: a new host or port,<br/>or the way out set by its one-row write"]
    Fix --> I
    Pass -->|"no: a private authority"| CA["0i again under<br/>docker exec -e NODE_EXTRA_CA_CERTS"]
    CA -->|"PASS"| Build
    CA -->|"FAIL"| Fix
    J["0j: the backup destinations,<br/>read-only"] --> Build
    Build --> K["0k: the same check in the new image,<br/>on production's network,<br/>with -e and -v for an authority"]
    K -->|"PASS, or way out set<br/>and the server reached"| Deploy["Deploy as in Updating a Running Installation"]
    K -->|"a connection failure, or FAIL<br/>without the way out"| Stop["Do not switch"]
    Deploy --> After["Checks 38 to 46 on production,<br/>47 to 50 on another instance"]
```

#### Before the deploy: checks 0i to 0k

**Check 0i: will mail go on after the deploy** (card 2189). On the host, against the running container, read-only: the command in [Mail Server Certificates](#mail-server-certificates), which reads the mail settings, prints names and flags, never the password, and makes the connection the new code makes, signing in to nothing and sending nothing. It runs in the image being replaced, whose nodemailer is 8.0.7: the connection it makes is what the new code asks for, and check 0k makes it again in the new image. Read it by the table under it, with these two ways to keep mail going through the deploy, for its `ETLS`, altnames and authority rows:

- **A change of host or port made before the deploy needs no password.** The code before this change keeps the stored password for any host and port, so the certificate's name as the host, or port 465, can be saved now with the password left masked. After the deploy it needs the password typed.
- **For a relay that cannot use TLS, the way out can be set before the deploy** with one write you choose to run. It changes one row: the code before this change does not read it, the new code reads it at the first mail, and the panel then shows the box ticked. No `WARN` line is written for it, since it is not set through the panel. With the container running:

  ```bash
  docker exec dumpfire node -e "
  const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { fileMustExist: true });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('smtp_allow_insecure', 'true');
  console.log('smtp_allow_insecure:', db.prepare('SELECT value FROM settings WHERE key = ?').get('smtp_allow_insecure').value);
  db.close();
  "
  ```

  It prints `smtp_allow_insecure: true`. Mail and its password then go as they do today: unencrypted wherever the relay offers no STARTTLS. The same write works after the deploy, with no password and no restart: the mailer reads the setting at every mail. Check 0i, run again, then prints `way out set`.

The go-ahead for mail is any one of these:

- `PASS` in both 0i and 0k;
- `way out set` printed by 0i, and 0k, given `wayOut = true`, not a connection failure;
- for a certificate from a private authority, `PASS` in 0i run under `docker exec -e NODE_EXTRA_CA_CERTS=/tmp/mail-ca.pem` (its table's authority row) and `PASS` in 0k run with `-e` and `-v`. The plain 0i goes on failing until the container is created with the variable, which is the deploy itself.

**Check 0j: which backup destinations decisions on Google Drive apply to** (cards 2188 and 2190). On the host, read-only; it prints types, names, flags and counts, never a secret:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_config');
let c = {};
try { c = JSON.parse((row || {}).value || '{}'); } catch (e) { console.log('backup_config is not JSON'); }
const list = Array.isArray(c.destinations) ? c.destinations : [];
const names = list.map((d) => String(d.name));
list.forEach((d, i) => console.log(i, d.type, JSON.stringify(d.name), '| name used', names.filter((n) => n === String(d.name)).length, 'time(s) | sign-in', d.authMethod || '-', '| folder set', Boolean(d.folderId), '| connected', Boolean(d.refreshToken), '| scope recorded', d.grantedScope || 'none'));
console.table(db.prepare('SELECT destination_name, destination_type, status, COUNT(*) AS runs, MAX(created_at) AS last FROM backup_log GROUP BY 1, 2, 3 ORDER BY 1, 3').all());
db.close();
"
```

A `gdrive` line with `sign-in oauth` and `connected true` is a connection made with the whole of Drive: it keeps working after the deploy, shows `⚠️ Connected · all of Drive`, and is narrowed when you choose (check 46). Production's log of 2026-10-18 shows one, "GoogleDriveTest", backing up at every run. `name used 2 time(s)` is two destinations of one name: Connect takes the first of them, and after the deploy **no save of the backup settings goes through while they are there**, the schedule's included: a list naming two destinations alike is refused, "Two backup destinations are named "<name>"." The way out, which the refusal gives: remove the destinations named "<name>" (the page's Remove removes every one of that name) and add it once with its secret typed. Where the two are the same in every other setting, a save or a test of one with its secret left masked is refused with the same way out. `sign-in service_account` and `folder set false` on a `gdrive` line whose runs fail are each a card of their own. `backup_log` keeps the last ten runs.

**Check 0k: the same check in the new image.** Once the new image is built and before the switch, with the host and port 0i printed in place of `HOST` and `587`, and `wayOut` set to `true` where 0i printed `way out set`. No volume and no database: it opens one connection and signs in to nothing. It runs on production's own network (`--network container:dumpfire`, the running container's), so it reaches the mail server as the new container will; under Docker Compose, put the running container's name in place of `dumpfire` (`docker compose ps` shows it). When an authority's certificate is used, add `-e NODE_EXTRA_CA_CERTS=/ca/mail-ca.pem -v /srv/dumpfire/mail-ca.pem:/ca/mail-ca.pem:ro` before the image name. The image's Node carries its own root certificates, and the `node:22-slim` tag moves, so the new image may trust otherwise than the running one:

```bash
docker run --rm --network container:dumpfire dumpfire:candidate node -e "
const host = 'HOST';
const port = 587;
const wayOut = false;
if (wayOut) { console.log('way out set: the go-ahead for mail, unless the check below cannot reach the server.'); }
require('nodemailer').createTransport({ host: host, port: port, secure: port === 465, requireTLS: port === 465 ? false : true, tls: { rejectUnauthorized: true }, name: 'dumpfire.app', connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 }).verify()
  .then(() => console.log('PASS: the mail server gives an encrypted connection with a certificate this image trusts.'))
  .catch((e) => console.log('FAIL:', e.code || '', e.message));
"
```

`dumpfire:candidate` is the image as built for the switch, under whatever tag it was given. Read it on its own:

- `PASS`: the go-ahead.
- `FAIL` for the certificate or STARTTLS (`ETLS`, `ECONNECTION … STARTTLS`, a certificate message): the go-ahead only with `way out set` printed above it. Without the way out, where 0i said `PASS` the new image does not trust the certificate: do not switch until it does.
- A connection failure (`ESOCKET connect…`, `EDNS`, a timeout) where 0i reached the mail server: **do not switch**, whether or not the way out is set. It runs on production's network, so the new image cannot reach a mail server the running one can; find why first. Where 0i failed the same way, mail is not working today either: this update neither causes nor mends that, and it does not hold the deploy back.

#### What changes at the first start

- **Mail goes over a checked, encrypted connection**, unless the way out is set. Nothing is written at start. A mail that fails for the certificate or STARTTLS is an `[ERROR] [EMAIL] Failed to send email …` line, and one `[WARN] [EMAIL] Mail is not being sent: <the error>. <how to put it right>` at most once in ten minutes, on the Audit page's Live Console.
- **The mail panel** has no "Use SSL/TLS"; it has "Allow mail without a checked, encrypted connection", unticked unless set in check 0i, with a line under the host and port and one under the password. Changing the host, port, user name or the box needs the mail password typed again.
- **Scheduled Backups** shows every secret as `••••••••`, and the answer it loads holds none. Changing any setting of a destination, its name included, needs its secret typed again; a connected Google Drive destination is removed, added again and connected. A list naming two destinations alike is not saved (check 0j). Backups run as before: they read the stored settings, never the masked answer.
- **A Google Drive OAuth destination connected before the deploy** shows `⚠️ Connected · all of Drive` with a line saying how to narrow it, and no button to connect it again. It goes on backing up as it did. New connections ask only for DumpFire's own files.
- `smtp_secure` is left in the database and no longer read. A working copy removes it and `smtp_allow_insecure` with the other mail settings.

**Owner to know.** Mail stops at the deploy if production's mail server fails checks 0i and 0k and neither of their ways was taken. Changing the mail host, port, user name or the way out now needs the mail password; changing any backup destination's settings, its name included, needs its password, key or secret. Keep them outside DumpFire. A Google Drive connection made before the deploy still reaches the whole of that Google account's Drive until it is narrowed: [To narrow a connection made before this change](admin-guide.md#configuring-backups), removing DumpFire's access in the Google account first, with the client secret at hand from the Google Cloud console. A new connection's backups go to a folder DumpFire makes, "DumpFire backups (made <date>)"; the copies in the old folder are no longer cleared by retention and are deleted by hand when not needed (they are from before card 2169, with every secret in them).

#### After the deploy

Checks 38 to 46 run on production, as the superadmin, and change nothing unless said. **Checks 47 to 50 run on an instance that is not production, with a database of its own**: a fresh data volume, set up with a superadmin of its own, `SCHEDULERS=off`, and outbound mail allowed. Never on production.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 38 | 2189 | Admin, 📧 Email / SMTP | The superadmin | No "Use SSL/TLS"; "Allow mail without a checked, encrypted connection" unticked (ticked only where check 0i set it); the port line and the password line. 🧪 Send Test arrives | It fails: run check 0i again and take its table's way. For a relay with no STARTTLS and the password not at hand, check 0i's one-row write sets the way out now, with no restart: the mailer reads it at the next mail |
| 39 | 2189 | Straight after the deploy, and again the next day: the Audit page's Live Console since the deploy. It reads what mail has been sent: check 38's Send Test is the first, so run 38 first; the next day's reading needs a mail sent meanwhile (a notification, an invite) | The superadmin | No `Mail is not being sent` `WARN` and no `Failed to send email` `ERROR` | Either: follow check 0i's table at once. The one-row write of check 0i sets the way out with no password and no restart, read at the next mail |
| 40 | 2190 | Change the SMTP host to `smtp.invalid` without typing the password, Save; reload | The superadmin | Refused, "Type the mail password again. … and this changes the host."; after the reload the host is as before | "SMTP settings saved!": set the host back at once |
| 41 | 2187 | Admin, ☁️ Scheduled Backups, with the browser's developer tools on Network: the answer of `/api/admin/backup` | The superadmin | Every secret field reads `••••••••`, a Google Drive OAuth destination's `refreshToken` included; its row still shows it connected | A long token value in the answer |
| 42 | 2190 | Edit a destination, change its host (or folder, or bucket) to `backup.invalid` without typing its secret, Save; then Cancel | The superadmin; any destination | Refused in a toast naming what changed and every secret still masked, "Backup destination "…": type its … again. …"; the list as before; the form still open until Cancel | Saved: set it back at once |
| 43 | 2190 | Edit a destination, change nothing, Save; then 🧪 Test | The superadmin | Saved; Test as before | Refused |
| 44 | 2187, 2188 | ▶ Run Now | The superadmin | Success at every destination, a Google Drive OAuth one connected before the deploy included | Any new failure |
| 45 | 2188 | A Google Drive OAuth destination connected before the deploy: its row | The superadmin | `⚠️ Connected · all of Drive`, the line under it beginning "Connected with access to all of this Google account's Drive. To narrow it: first remove DumpFire's access in the Google account", and no button to connect it again | `✅ Connected`, or a button to connect it again |
| 46 | 2188 | **When you choose to narrow it:** the three steps of [To narrow a connection made before this change](admin-guide.md#configuring-backups), removing access first; then ▶ Run Now and 🧪 Test | The superadmin; the Google account; the client secret | Google's consent screen asks only for "the specific Google Drive files you use with this app"; Connect says it made the folder "DumpFire backups (made <today>)"; `✅ Connected`; that folder in the account's My Drive holds the new copy; Test says "Connected to Google Drive folder (1 existing file)" | A consent screen asking for all of Drive; Connect refused for the new empty Folder ID; the backup fails |
| 47 | 2189 | On the other instance: mail host the IP address of `smtp.gmail.com` (`nslookup smtp.gmail.com`), port 587, user `x`, password `y`; Save; 🧪 Send Test | Its superadmin | Refused, "Hostname/IP does not match certificate's altnames", followed by "The mail server's certificate could not be checked, or the server does not offer STARTTLS. …" | A sign-in error: the certificate was not checked |
| 48 | 2189, 2190 | Tick the way out without typing the password; Save | | Refused, "… and this changes the "Allow mail without a checked, encrypted connection" setting." | Saved |
| 49 | 2189 | Tick it, type `y`, Save; 🧪 Send Test; read the Live Console | | The warning shows under the box; the test fails at sign-in (`535`), past the certificate; one `[WARN] [SMTP] Mail is now sent without a checked, encrypted connection (set by …)` | The certificate error again, or no `WARN` |
| 50 | 2189 | Untick it, host `smtp.gmail.com`, type `y`, Save; 🧪 Send Test | | Fails at sign-in (`535`), not at the certificate; one `[WARN] [SMTP] Mail is now sent with a checked, encrypted connection (set by …)` | A certificate error |

#### Going back to the previous image

Nothing is done to the database.

- **The mail settings.** The older image reads `smtp_secure` again, which this image left as it was, and never reads `smtp_allow_insecure`: mail on any port but 465 goes as before this change, STARTTLS only if offered and the certificate checked only where "Use SSL/TLS" was ticked. A mail host, port or user changed meanwhile stays. A password typed meanwhile stays.
- **The backup settings.** The older image masks the secrets it knew and shows the Google Drive refresh token again; it takes a masked secret by its place in the list again. A `grantedScope` recorded by a Connect meanwhile stays in the destination and is not read. A destination connected meanwhile keeps its `drive.file` token and the folder DumpFire made, and backs up there.
- **nodemailer** goes back to 8.0.7 with the older image.

### The Update That Brings Migration 0056 and the Webhook Rules

Five cards go out in one image, and this is the one note for them. One migration, no data changed.

- **Card 2145** sends each webhook of a board on its own: a webhook whose stored `events` is not a JSON list is skipped with a `WARN`, where one holding `null` stopped every later webhook of its board, a number or an object was sent every event, and a string was matched by substring.
- **Card 2161** refuses a webhook's address inside the network: at registration as written (`400`), and at every delivery as written and by every address its name resolves to (a `WARN`, nothing sent). Redirects are not followed, an address with a user name or password is refused, and a failed delivery's `ERROR` names the host, never the path. Webhooks are delivered with `node:http` and `node:https`, not `fetch`. A receiver inside the network on purpose is named in `WEBHOOK_ALLOW_INSIDE`: see [Where a Webhook May Send](#where-a-webhook-may-send).
- **Card 2154** keeps a webhook's address and secret, and switching it on, with the board's owner and administrators: an editor's key that sends `url` or `secret`, or `active: true` for a webhook that is off, is `403`.
- **Card 2168** brings migration `0056_add_webhook_set_by.sql`, a column `webhooks.set_by` (the account that last set the webhook's address or secret) and its index, and with it what taking an account back switches off: an administrator's reset and an invite used switch off every webhook the account set and pause every report schedule of it; the holder's own change with the box ticked switches off the webhooks; deleting an account switches off the webhooks it set.
- **Card 2201** holds a board to 10 webhooks, switched-off ones counted: the 11th create is `409`. A board that already has more keeps them all, and is named at every start.

0056 is two statements and changes no row:

```sql
ALTER TABLE `webhooks` ADD COLUMN `set_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhooks_set_by` ON `webhooks` (`set_by`);
```

```mermaid
flowchart TD
    L["0l: each webhook's host and what it resolves to,<br/>in the container, read-only"] --> Inside{"A host inside the network<br/>that is wanted?"}
    Inside -->|"Yes"| Allow["WEBHOOK_ALLOW_INSIDE on the new container"]
    Inside -->|"No"| R
    Allow --> R["0c: the rehearsal lists 0056"]
    M["0m: webhooks whose events are not a list,<br/>on the host, read-only"] --> R
    N["0n: the boards with the most webhooks,<br/>on the host, read-only"] --> R
    R --> Deploy["Deploy as in Updating a Running Installation"]
    Deploy --> First["First start: 0056 applied,<br/>no row changed, every webhook with no setter"]
    First --> After["Checks 51 to 71"]
```

#### Before the deploy: checks 0l to 0n

Each runs on the host, against the live database, read-only. None prints a path, a query string, a secret or a password: a webhook's path can hold a token. Check 0l also asks the container's resolver for each host it lists, and connects to nothing.

**Check 0l: where each webhook sends.** Each webhook's board, whether it is on, when it was made, the host and port it sends to and the addresses that host resolves to now from inside the running container, with whether its address carries a user name or password and whether it is written in an odd form:

```bash
docker exec dumpfire node -e "
const dns = require('dns');
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT id, board_id, active, created_at, url FROM webhooks ORDER BY id').all();
db.close();
const backslash = String.fromCharCode(92);
const read = (url) => {
  const sep = url.indexOf('://');
  const rest = sep < 0 ? url : url.slice(sep + 3);
  const ends = ['/', '?', '#', backslash].map((c) => rest.indexOf(c)).filter((i) => i >= 0);
  const authority = ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
  const at = authority.lastIndexOf('@');
  const hostAndPort = authority.slice(at + 1);
  const host = hostAndPort.startsWith('[') ? hostAndPort.slice(1, hostAndPort.indexOf(']')) : hostAndPort.split(':')[0];
  const lower = url.toLowerCase();
  const usual = (lower.startsWith('http://') || lower.startsWith('https://')) && url.includes(backslash) === false;
  return { hostAndPort, host, credentials: at >= 0 ? 1 : 0, odd: usual ? 0 : 1 };
};
const hosts = [...new Set(rows.map((r) => read(r.url).host))];
const looked = hosts.map((h) => dns.promises.lookup(h, { all: true }).then((found) => found.map((a) => a.address).join(' '), (err) => 'not resolved: ' + err.code));
Promise.all(looked).then((answers) => {
  const resolved = new Map(hosts.map((h, i) => [h, answers[i]]));
  console.table(rows.map((r) => {
    const w = read(r.url);
    return { id: r.id, board_id: r.board_id, active: r.active, created_at: r.created_at, host_and_port: w.hostAndPort, resolves_to: resolved.get(w.host), has_credentials: w.credentials, odd_form: w.odd };
  }));
});
"
```

Read it for five things:

- **A host inside the network**, as written or in `resolves_to`: an address `10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `127.x`, `100.64.x` to `100.127.x`, `169.254.x`, `::1`, `fd…` or `fe80…`; `localhost`; a name with no dot (`n8n:5678`); or a name ending `.local`, `.internal` or `.home.arpa`. That webhook stops being delivered when the new image starts, with a `WARN` at the first event and at most once an hour after. If it is wanted, put its host in `WEBHOOK_ALLOW_INSIDE` on the new container (see [Where a Webhook May Send](#where-a-webhook-may-send)). `resolves_to` is what the container's own resolver answers now, every address of the name; a public name that answers an inside address is refused at delivery too. `not resolved: ENOTFOUND` is a name the container cannot resolve, which is not delivered now either.
- **An `http://` host that is sent**: run `curl -sI http://<host_and_port>/` against each from a machine outside, or from the container. A `307` or `308` there may mean its receiver redirects every `POST`, which stops being followed at the deploy (see [What changes at the first start](#what-changes-at-the-first-start)).
- **`has_credentials` 1**: that webhook has never been delivered (`fetch` refused such an address) and still will not be. The board's owner or an administrator registers it again without them. The host is read after the last `@`, as the URL parser reads it, so a password holding `@` does not hide the host.
- **`odd_form` 1**: an address not beginning `http://` or `https://`, such as `http:/127.0.0.1/x`, or one holding a backslash, which the URL parser reads as `/` (`http://hooks.example.com\@10.0.0.5/`), whose host this check may misread. Look at that row's address by hand.
- **Any row at all**: after 0056 none has a recorded setter, so a password reset will not switch it off. Look each over once, with the board's owner.

**Check 0m: webhooks whose events are not a list** (card 2145):

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT id, board_id, active, events FROM webhooks WHERE CASE WHEN json_valid(events) THEN json_type(events) <> @array ELSE 1 END ORDER BY id').all({ array: 'array' }));
db.close();
"
```

An empty table is what is expected. Any row is skipped at every event from the deploy on, with a `WARN` naming it, where before it stopped the board's later webhooks (`null`), was sent every event (a number or an object) or was matched by substring (a string). Fix each with `PUT /api/v1/webhooks/{id}` and a list of events, before or after the deploy; check 69 looks at it afterwards.

**Check 0n: the boards with the most webhooks** (card 2201):

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT w.board_id, b.name AS board_name, COUNT(*) AS webhooks, SUM(w.active) AS active, MIN(w.created_at) AS first_made, MAX(w.created_at) AS last_made FROM webhooks w LEFT JOIN boards b ON b.id = w.board_id GROUP BY w.board_id ORDER BY webhooks DESC, w.board_id LIMIT 20').all());
db.close();
"
```

A board above 10 keeps every webhook and every delivery after the deploy, no webhook can be added to it until it has fewer than 10, and every start names it (check 67). Look at each with its owner and delete what is not wanted; one made in a burst (`first_made` close to `last_made`) is worth a closer look. Boards at 8 to 10 with genuine integrations are within reach of the cap.

**In the rehearsal (check 0c)**, `Migration files applied` lists `0056_add_webhook_set_by.sql` too, with no note under `Worth knowing`: it changes no row, and declares nothing.

#### What changes at the first start

- **0056 is applied**: one column and one index, no row changed. Every webhook there has no setter, so no reset switches one off until its address or secret is set again. A webhook registered from now on names the account that registered it.
- **Every webhook is judged by where it sends**, at each event. One that check 0l showed inside the network, and that `WEBHOOK_ALLOW_INSIDE` does not name, is not sent, and writes a `WARN` under `Webhooks` at the first event it would have been sent: `Webhook 4 on board 3 not sent: 127.0.0.1 is a loopback address`. A receiver that answers with a redirect is a `WARN`, not followed. Each such `WARN` is written one line per webhook and kind of refusal per hour, however its words change (another address resolved, another status), the next one saying how many were not written in between (`… (12 more like this since the last such line were not logged)`), so a busy board does not fill the system log, which keeps 50,000 rows. Only a receiver that answers `307` or `308` newly stops: a `301`, `302` or `303` was already followed by `fetch` as a `GET` with no body, which no webhook receiver takes, so such a receiver was not receiving before either. Check 0l's `curl -sI` finds them. A delivery that fails writes `ERROR` naming the host and port, never the path. The receiver sees the same body, event header, signature and `User-Agent` as before, with `Content-Length` (never chunked), `Accept: */*` and `Connection: close`, and none of the other headers `fetch` added (`accept-language`, `sec-fetch-mode`, `accept-encoding`).
- **The start log** has a `[WARN] [STARTUP]` line for each ignored entry of `WEBHOOK_ALLOW_INSIDE`, one naming the boards over 10 webhooks, and one naming each webhook that is on and refused as written (the hosts inside the network that check 0l found, unless the list names them), only where there are any.
- **At `LOG_LEVEL=ERROR`** none of that is written: the refusal and redirect `WARN`s and the two start-up lines about webhooks (the allow-list's and the refused webhooks') are below the level, so a receiver inside the network that stops at the deploy leaves no trace. Run with `INFO` or `WARN` for the first days, or run check 0l again after the deploy.
- **Through the API**: an address inside the network is `400` at registration; an editor's `url`, `secret` or switching on is `403`, ending "Ask the board's owner." (an editor whose own webhook their own reset switched off asks the owner too, or deletes it and creates it again); the 11th webhook of a board is `409`. Scripts that send back a webhook's whole answer with a changed `events` are refused when run with an editor's key: send only the fields that change.
- **On the pages**: the admin page's reset dialog counts the webhooks the account set and its report schedules, and the toast names what was switched off and paused; the Account page's password box offers to switch off the webhooks you set, and can appear with no API key; the invite page names what setting a password there ends; the delete confirmation says webhooks are switched off.

**Owner to know.** An address inside the network stops being sent at the deploy unless `WEBHOOK_ALLOW_INSIDE` names it, and an entry of that list wider than one inside range is ignored, named in the start log. An editor can no longer change a webhook's address or secret, or switch one on. A password reset, an invite used, and the holder's own change with the box ticked switch off the webhooks the account set (reset and invite pause its report schedules too), and so does deleting the account; the board's owner or an administrator switches a webhook on again through the API, and a schedule's owner on the Reports page. A board holds at most 10 webhooks. A webhook can still reach this server's own public address: nothing on the host is to trust a request for coming from it.

#### After the deploy

Checks 51 to 69 run on production; 70 and 71 on a development instance. Accounts: the superadmin; an ordinary user `qb-check` who owns a board "QB check" and a board "QB cap"; an ordinary user `qb-editor`, editor on "QB check"; an API key for each of the two. A public request catcher (such as `https://webhook.site`, which gives a unique address) receives the webhooks. In Windows PowerShell 5.1 send each request with `curl.exe` and its body from a file (`-d "@hook.json"`): 5.1 strips the quotes from JSON typed on the line.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 51 | 2161 | `POST /api/v1/boards/{QB check}/webhooks` with `{"url":"<catcher>","secret":"s3"}`; move a card on the board | `qb-check`'s key | `201`; the catcher receives a `POST` with `X-DumpFire-Event: card.moved`, `X-DumpFire-Signature: sha256=…`, `Content-Length`, `Accept: */*`, and no `Transfer-Encoding` | Not received, or `Transfer-Encoding: chunked` |
| 52 | 2161 | `POST` the same with each of `http://127.0.0.1:3000/x`, `http://localhost/x`, `http://169.254.169.254/latest/meta-data/`, `http://n8n:5678/x`, `https://u:p@example.com/` | `qb-check`'s key | `400` each: `Webhook url points inside the network: 127.0.0.1 is a loopback address`, `…: localhost is this server`, `…: 169.254.169.254 is a link-local address, where the cloud metadata service is`, `…: n8n is a name with no dot, which is looked up inside the network`, and `Webhook url must not carry a user name or password` | Any `201` |
| 53 | 2161 | `POST` with `http://localtest.me:3000/x` (a public name that resolves to `127.0.0.1`); move a card; open the Audit page's Live Console | `qb-check`'s key; the superadmin | `201`, then `WARN` `Webhook N on board B not sent: localtest.me resolves to 127.0.0.1, a loopback address` | The `201` followed by no line |
| 54 | 2161 | `POST` with `http://169.254.169.254.nip.io/x`; move a card | `qb-check`'s key | `201`, then a `WARN` ending `resolves to 169.254.169.254, a link-local address, where the cloud metadata service is` | No line |
| 55 | 2154 | `PUT /api/v1/webhooks/{51's id}` with `{"url":"<another catcher>"}`; then `{"active":false}`; then `{"active":true}` | `qb-editor`'s key | `403` `Only the board's owner or an administrator can change a webhook's address or secret. Ask the board's owner.`; `200`; `403` `Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.` | `200` to the first or the third |
| 56 | 2154 | `PUT` the same webhook `{"active":true}` | `qb-check`'s key | `200` | `403` |
| 57 | 2168 | Make a report schedule on the Reports page; then, as the superadmin, reload the admin page and open 🔑 on `qb-check`'s row | `qb-check`; the superadmin | After a moment: "They have 1 API key, which stops working.", "They set up 3 webhooks, which are switched off." (checks 51, 53, 54) and "They have 1 report schedule, which is paused." | No counts, or wrong ones |
| 58 | 2168 | Reset `qb-check`'s password; move a card on "QB check"; read the Live Console | The superadmin | The toast "Password reset: … and 1 API key ended, 3 webhooks switched off and 1 report schedule paused" (the sessions as they were); the catcher receives nothing; an `AUTH` line naming the three webhooks and the schedule by id | The catcher receives `card.moved` |
| 59 | 2168 | Sign in with the new password; Reports, Schedules | `qb-check` | The schedule shows ⏸️; switching it on works | ✅ before it is switched |
| 60 | 2168 | Make a key on the Account page; register a webhook to the catcher with it; change the password **without** ticking the box; move a card | `qb-check` | The catcher receives it | Not received |
| 61 | 2168 | Change the password again **with** the box ticked ("End my 1 API key too, and switch off the 1 webhook I set up."); move a card | `qb-check` | "Password changed. Your other sessions were signed out; your 1 API key was ended and the 1 webhook you set up was switched off."; the catcher receives nothing | Received |
| 62 | 2168 | Make a key, register a webhook to the catcher, delete the key on the Account page and reload it; tick the box, change the password, move a card | `qb-check` | The box reads "Switch off the 1 webhook I set up."; the catcher receives nothing | No box, or the event received |
| 63 | 2168 | Make `qb-gone`, give it a key, register a webhook on a board of its own; delete `qb-gone`; `GET /api/v1/webhooks/{id}` | The superadmin, and the superadmin's key | The confirmation says "Webhooks they set up are switched off; the board's owner or an administrator can switch one on again through the API."; the webhook answers `"active": false`; the delete's log line says "1 webhook(s) they set up were switched off (id N)", N the webhook's id | `"active": true` |
| 64 | 2201 | Put `{"url":"<catcher>"}` in `hook.json`; then `1..11 \| % { curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@hook.json" https://<host>/api/v1/boards/<QB cap>/webhooks }` | `qb-check`'s key (a new one) | Ten answers ending `201`; the 11th `{"message":"This board has 10 webhooks, and a board may have at most 10: delete 1 before adding another."} 409` | A `201` for the 11th |
| 65 | 2201 | `PUT` one of them `{"active":false}`; create again | `qb-check`'s key | Still `409` | `201` |
| 66 | 2201 | `DELETE` one; create again | `qb-check`'s key | `201` | `409` |
| 67 | 2161, 2201 | Read the start log (`docker logs dumpfire 2>&1`, or the Live Console) | | A `[WARN] [STARTUP]` line naming each board check 0n listed above 10, and none if it listed none; a line naming each webhook that is on and refused as written (checks 52 and 53's are not: 52's were refused, 53's name looks outside as written), and none if there is none; no `WEBHOOK_ALLOW_INSIDE` line unless an entry is wrong | A line naming a board of 10 or fewer, or one holding an address |
| 68 | 2201 | Open `/docs`, Webhooks, Create a webhook | | A `409` listed with the text of check 64 | No `409` |
| 69 | 2145 | Only if check 0m listed rows: move a card on such a board | | Its other webhooks receive; one `WARN` names the row, "its events are not a list" | Nothing received |
| 70 | 2161 | On a development instance started with `WEBHOOK_ALLOW_INSIDE=127.0.0.1`, run the receiver below; register `http://127.0.0.1:9911/x`; move a card | That instance's user and key | `201`, and the receiver prints the `POST` | `400`, or nothing received |
| 71 | 2161 | Start that instance with `WEBHOOK_ALLOW_INSIDE=0.0.0.0/0,::/0,10.0.0.0/2,127.1,::/8,0.0.0.0/8,10.0.5.0/24`; `POST` `http://169.254.169.254/x`, `http://127.0.0.1:9911/x`, `http://[::1]:9911/x` and `http://10.0.5.20/x` | That instance's user and key | Six `[WARN] [STARTUP]` lines, one for each of the first six entries; `400`, `400`, `400` and `201` | Any of the first three `201` |

Check 70's receiver, on the development machine:

```bash
node -e "require('http').createServer((q, s) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { console.log(q.method, q.url, b); s.end('ok'); }); }).listen(9911)"
```

Delete the check accounts, the two boards and the catcher's webhooks afterwards.

#### Going back to the previous image

Nothing is done to the database.

- **0056 stays applied.** The older image logs one `[ERROR] [DB]` line for the recorded file it has no file for, and its schema check one for the column and the index its model lacks, and starts. It neither reads nor writes `set_by`: a webhook it makes names nobody.
- **The webhook rules go with it.** It delivers to addresses inside the network again, follows redirects, lets an editor change an address or a secret or switch a webhook on, and has no cap. A webhook switched off by a reset meanwhile stays off; a schedule paused stays paused.
- **Its restore fills a webhook's secret** by id, board and address again, without the setter.

### The Update That Brings Migration 0057 and the Second Round of Read Leaks

Six cards go out in one image, and this is the one note for them. Each closes a way for someone to read something of a board they cannot open. One migration, which changes data once; run query 3 (check 0o) before the deploy.

- **Card 2150**: a report is its reader's. A board or grouping report takes in only the sub-boards its reader can open, and does not walk through one they cannot; a board whose parent the reader cannot open is drawn as a board of its own, the parent not named. The reader is the caller for a download, the sender for a mailed report, and the schedule's owner, as their account stands at each run, for a scheduled one. The Reports page lists, for an ordinary user, each board they can open whose parent board they cannot. See [Whose Report It Is](backup-reporting.md#whose-report-it-is).
- **Card 2151**: completing a card held back only by sub-boards the caller cannot open is refused with `A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board's owner.`, with no name and no count.
- **Card 2152**: the "Unblocked" comment names finished work on another board by its number only, and each "Unblocked" and "Plan created" mail is drawn for its recipient; the plan mail goes only to those who can open the plan.
- **Card 2153**: the inbox gives a request's desired board only to a reader who can open it, and so does the answer to an accept or a reject.
- **Card 2155** brings migration `0057_cards_leave_other_boards_milestones.sql`: a move to another board takes the card out of a milestone of a board other than the one it arrives on, and 0057 takes out, once, the cards already in that state.
- **Card 2170**: an open board stream asks at each heartbeat whether its account can still open the board, and ends with one `update` of `{"type":"access"}` when not; it no longer opens on a board that is not there. `/api/events` decides each board again at its heartbeat.

0057 is one statement, which changes data and no structure:

```sql
UPDATE `cards` SET `milestone_id` = NULL
WHERE `milestone_id` IN (SELECT `id` FROM `milestones` WHERE `board_id` IS NOT NULL)
  AND (SELECT `board_id` FROM `milestones` WHERE `id` = `cards`.`milestone_id`)
      <> (SELECT `board_id` FROM `columns` WHERE `id` = `cards`.`column_id`);
```

It leaves `updated_at` as it is (nobody edited the cards) and writes no activity entry. A goal across boards (no board) keeps every card, and so does a goal whose card is on its own board. Archived cards and closed goals are included. A goal whose board row is gone (deleted while foreign keys were off, as a restore runs) loses its cards too, since no column is on a board that is not there; a card naming a goal that no longer exists is left alone. So is a card whose column row is gone (deleted while foreign keys were off): it is shown nowhere, its board is unknown, and a comparison with an unknown board is never true, so it keeps its milestone and query 3 does not list it. The file runs once; the start-up backfill of card 2179 repeats the same statement at every start and after every restore (below). Why: [Critical-Path Planning](critical-path-planning.md#constraints-worth-knowing).

**The start-up backfill repeats 0057** (card 2179, the update after this one). The file is recorded as applied and never runs again, but the same statement runs as a backfill at every start and after every restore, so a database that gets cards in a milestone of another board again (after going back to an older image, using it, and coming forward again, or after Import Backup of a backup made before this update) has them taken out at the next start or at the restore itself, with a `WARN` line or a count in the restore's report. Until that update is on production, nothing repeats 0057: after either, run query 3 (check 0o) on the host and fix each card it lists by hand, as check 0o says: move it to its goal's board, make the goal one across boards, or take it out of the goal in its card window.

```mermaid
flowchart TD
    Q3["0o: query 3, the cards 0057 takes out,<br/>on the host, read-only, kept in query-3-before.txt"] --> Keep{"A card listed that should<br/>stay with its goal?"}
    Keep -->|"Yes"| Back["Move it back to the goal's board,<br/>or make the goal one across boards"]
    Keep -->|"No"| Tell["Tell each listed goal's owner"]
    Tell --> R
    Back --> Q3
    P["0p: report schedules that will hold fewer boards,<br/>on the host, read-only"] --> R
    T["0q: pending requests that name a board,<br/>on the host, read-only"] --> R
    R["0c: the rehearsal lists 0057,<br/>and notes the change to cards"] --> Deploy["Deploy as in Updating a Running Installation"]
    Deploy --> First["First start: 0057 applied,<br/>the cards query 3 listed leave their milestones"]
    First --> After["Checks 72 to 90"]
```

#### Before the deploy: checks 0o to 0q

Each runs on the host, against the live database, read-only, as near the deploy as you can: a card moved to another board after the check is taken out too, which is the rule anyway. Save each query below in a file of its own beside you on the host, and pipe it in; nothing in the commands needs escaping, and each prints a table.

**Check 0o: query 3, exactly the cards 0057 takes out of their milestones** (card 2155). It selects by 0057's own `WHERE`, with left joins for the names, so it lists what the statement changes and nothing else. `milestone_board` empty means the goal's board row is gone. Archived cards and closed goals are listed. A card whose column row is gone is not listed, and 0057 leaves it in its goal: no page shows such a card, and its board cannot be compared. Save it as `query-3.sql`:

```sql
SELECT c.id AS card_id, c.title, c.archived_at, m.id AS milestone_id, m.name AS milestone,
  m.status AS milestone_status, m.board_id AS milestone_board_id, mb.name AS milestone_board,
  col.board_id AS card_board_id, cb.name AS card_board
FROM cards c
JOIN milestones m ON m.id = c.milestone_id
LEFT JOIN columns col ON col.id = c.column_id
LEFT JOIN boards mb ON mb.id = m.board_id
LEFT JOIN boards cb ON cb.id = col.board_id
WHERE c.milestone_id IN (SELECT id FROM milestones WHERE board_id IS NOT NULL)
  AND (SELECT board_id FROM milestones WHERE id = c.milestone_id)
      <> (SELECT board_id FROM columns WHERE id = c.column_id)
ORDER BY m.id, c.id;
```

```bash
docker exec -i dumpfire node -e "
const sql = require('fs').readFileSync(0, 'utf8');
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare(sql).all());
db.close();
" < query-3.sql > query-3-before.txt
```

The table is wider than a terminal, so it goes to `query-3-before.txt`; open that file to read it. **Keep the file after the deploy**: nothing else records what 0057 changed, since the cards' `updated_at` and the activity log are left as they were. Each run writes over it, so after the last run before the deploy it holds exactly what 0057 changes.

An empty table means 0057 changes nothing. Each row is a card that leaves its milestone at the deploy. Tell each listed goal's owner (whoever made it, `created_by` of its `milestones` row, or the owner of its board) which of their goal's cards leave it, as check 0p tells a schedule's owner. To keep one with its goal, do one of these on production before the deploy, then run the check again:

1. **Move the card back to the goal's board** (All Tasks, Move). The goal stays as it is.
2. **Make the goal one across boards** through the API, with an administrator's key; no screen changes a goal's board. Put `{"boardId":null}` in `goal.json`, then:

   ```bash
   curl.exe -s -X PATCH -H "Authorization: Bearer <administrator's API key>" -H "Content-Type: application/json" -d "@goal.json" https://<host>/api/v1/milestones/<milestone id>
   ```

   A goal across boards can then be opened only by people who can open every board its cards are on: a reader of the goal's board who cannot open the moved card's board loses the whole goal, not just that card.

**Check 0p: report schedules that will hold fewer boards** (card 2150). Enabled schedules of a board or grouping owned by an ordinary user, and the sub-boards under them (any depth) that the owner cannot open: the boards each such report leaves out from the deploy on. Shares by team and public boards count as access. A board further down that the owner can open, under one they cannot, leaves the report too and is not listed. Save it as `query-1.sql`:

```sql
WITH RECURSIVE
can_open(user_id, board_id) AS (
  SELECT created_by, id FROM boards WHERE created_by IS NOT NULL
  UNION SELECT user_id, board_id FROM board_members
  UNION SELECT tm.user_id, bt.board_id FROM board_teams bt JOIN team_members tm ON tm.team_id = bt.team_id
  UNION SELECT u.id, b.id FROM users u CROSS JOIN boards b WHERE b.is_public = 1
),
owners AS (
  SELECT s.id AS schedule_id, s.name AS schedule, s.user_id, s.scope, s.scope_id
  FROM report_schedules s JOIN users u ON u.id = s.user_id
  WHERE s.enabled = 1 AND u.role = 'user' AND s.scope IN ('board', 'category')
),
tops(schedule_id, user_id, board_id) AS (
  SELECT schedule_id, user_id, scope_id FROM owners WHERE scope = 'board'
  UNION
  SELECT o.schedule_id, o.user_id, b.id FROM owners o JOIN boards b ON b.category_id = o.scope_id
  WHERE o.scope = 'category' AND (o.user_id, b.id) IN (SELECT user_id, board_id FROM can_open)
),
walk(schedule_id, user_id, board_id) AS (
  SELECT schedule_id, user_id, board_id FROM tops
  UNION
  SELECT w.schedule_id, w.user_id, sb.id
  FROM walk w JOIN columns col ON col.board_id = w.board_id
  JOIN cards c ON c.column_id = col.id
  JOIN boards sb ON sb.parent_card_id = c.id
)
SELECT o.schedule_id, o.schedule, sb.id AS sub_board_id, sb.name AS sub_board
FROM walk w JOIN owners o ON o.schedule_id = w.schedule_id
JOIN boards sb ON sb.id = w.board_id
WHERE sb.parent_card_id IS NOT NULL
  AND (w.user_id, sb.id) NOT IN (SELECT user_id, board_id FROM can_open)
ORDER BY o.schedule_id, sb.id;
```

Run it as check 0o's command with `query-1.sql` in place of `query-3.sql` and `query-1.txt` in place of `query-3-before.txt`, so the record of check 0o is kept. Nothing to rule on: each row is a sub-board that schedule's recipients stop receiving, with no line in the report saying so. Tell its owner if it matters; giving the owner the sub-board puts it back.

**Check 0q: pending requests that name a board** (card 2153), the only ones whose inbox badge can change. Save it as `query-2.sql` and run it the same way, into `query-2.txt`:

```sql
SELECT tr.id, tr.target_type, tr.target_id, b.name AS desired_board
FROM task_requests tr JOIN boards b ON b.id = tr.desired_board_id
WHERE tr.status = 'pending'
ORDER BY tr.id;
```

A request addressed to someone who cannot open its board shows them no badge from the deploy on, and its accept dialog starts at "Select a board…".

**In the rehearsal (check 0c)**, `Migration files applied` lists `0057_cards_leave_other_boards_milestones.sql` too, and, for an export that holds cards, a note under `Worth knowing`: `cards: milestone_id cleared where it named a milestone of another board in its N row(s) by 0057_cards_leave_other_boards_milestones.sql, a one-off declared in tests/rehearsal/one-offs.ts`. Expected, not a failure. N is every row of `cards`, not the number changed: the rehearsal compares row counts and cannot see an `UPDATE`, so query 3 is the one view of what 0057 changes. The rehearsal still fails if `cards` loses a row.

#### What changes at the first start

- **0057 is applied**: the cards check 0o listed (`query-3-before.txt`) leave their milestones, once; their goals' counts and plan pages no longer hold them. No structure changes, so the schema check has nothing to say, and a later start changes nothing.
- **An affected goal's history changes with it.** Which goal a card is in is not historised: the burndown, the milestone PDF and a closed goal's final figures are drawn from the goal's cards as they are now, across the goal's whole window. So each goal check 0o listed shows, from the deploy on, a burndown, a PDF and (closed) final figures without the cards that left it, for every day back to its start, not only from the deploy. The same happens to a goal after every later move of one of its cards to another board. Keep a goal's PDF from before the deploy if its figures as they were matter.
- **Reports** downloaded, mailed or scheduled by someone who was not given every sub-board of their board leave those sub-boards out (check 0p). A report of a sub-board shared with someone who cannot open its parent no longer names the parent. A schedule's report follows its owner's access at each run, growing as well as shrinking.
- **"Unblocked" comments** written from now on about a card on another board read `Unblocked: #12, a card on another board, completed — nothing is blocking this card now.`; those written before stay as they are. The "Unblocked" mail gives an assignee who cannot open the finished card's board "A card on a board you cannot open" in place of its title, and the "Plan created" mail goes only to recipients who can open the plan.
- **A move to another board** takes the card out of a milestone of the board it left, and the board's activity says so: `"T" moved to board "B" (To Do → To Do) and out of milestone "M"`, or, when the next update (card 2181) is in the same image, `"T" moved to another board (To Do → To Do) and out of milestone "M"`. Through the API the move answers `milestoneId: null` and names the milestone left as `leftMilestone`, and All Tasks says `Moved. It left milestone "M"; moving it back does not put it back in.` in a toast.
- **An open board** turns into "You do not have access to this board" within about 30 seconds of its reader losing access, where it went on receiving the board's events while the session lasted. `GET /api/boards/{id}/events` on a board that is not there is `404` for everyone, administrators included.
- **No new log line** is written for any of it.

**Owner to know.** A report leaves out the sub-boards its reader cannot open, with no line saying so, and its recipients get the sender's or the schedule owner's view whoever they are. Someone who cannot open a card's unfinished sub-board is told that a sub-board they cannot open is unfinished, not its name. An "Unblocked" comment about a card on another board gives its number, not its title. An assignee who cannot open a plan is no longer mailed when it is created. A request naming a board the reader cannot open shows no badge to them. Moving a card to another board takes it out of a milestone of the board it left, and All Tasks says so; a goal across boards keeps it. A goal that loses a card, at the deploy or by a later move, shows a burndown, PDF and final figures without it for its whole window. Someone taken off a board, or an administrator made an ordinary user who is not on it, sees the open board turn into a refusal within about 30 seconds.

#### After the deploy

Checks 72 to 90 run on production. Accounts: the superadmin (or an administrator), a second administrator `qa-admin2`, and an ordinary user `qa-reader`, each in a browser of their own, and an API key of the administrator's and of `qa-reader`'s. Data: board A with `qa-reader` as a member; under a card of A a sub-board S made by the administrator and not shared, with a card titled "S secret"; board B that `qa-reader` cannot open; a board P that `qa-reader` cannot open with a sub-board P1 shared with `qa-reader`; a board "QA spare" with `qa-reader` as a member. Mail set up; `qa-reader`'s address a mailbox you can read; `qa-reader` and `qa-admin2` with the "Card Moves" and "Planning" mail preferences on. In Windows PowerShell 5.1 send each request with `curl.exe` and its body from a file, as in checks 51 to 71.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 72 | 2150 | Reports, board A, download the PDF | `qa-reader` | No S and no "S secret" | Either |
| 73 | 2150 | The same | The administrator | S nested under A, with "S secret" | S missing |
| 74 | 2150 | Email the report of board A to your own address | `qa-reader` | The attached PDF has no S | S in it |
| 75 | 2150 | Make a weekly schedule of board A to your own address, for today's weekday, a few minutes ahead in the server's time of day (UTC in the container unless `TZ` is set); wait for it | `qa-reader` | The mailed PDF has no S | S in it |
| 76 | 2150 | Reports: P1 is in the board list; download its report | `qa-reader` | P1 alone, with P's name nowhere in it | P1 not listed, or P's name in it |
| 77 | 2151 | Make `qa-reader` an editor of A. Put `{"columnId":<A's Complete column id>}` in `move.json`; `curl.exe -s -X PUT -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@move.json" https://<host>/api/v1/cards/<the card that holds S>/move` | `qa-reader`'s key | `409` `{"message":"A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board's owner."}` (a drag on the board page is stopped before it is sent, in the page's own words) | S's name, or the card completes |
| 78 | 2151 | The same | The administrator's key | `409` naming S: `Sub-board "S" has 1 incomplete card that must be completed first` | The generic message |
| 79 | 2152 | Card W on A assigned to `qa-reader`, waiting on card X on B; complete X | The administrator | On W, `Unblocked: #X, a card on another board, completed — nothing is blocking this card now.`; `qa-reader`'s mail says "A card on a board you cannot open" | X's title in either |
| 80 | 2152 | The same with X on A | The administrator | The comment names X by title, as before | The number only |
| 81 | 2152 | Through the API or the wrapper, attach to an empty milestone of A two cards, one assigned to `qa-reader` and `qa-admin2` and waiting on X on B | The administrator's key | `qa-reader`'s "Plan created" mail shows `#X A card on a board you cannot open` in the chain; `qa-admin2`'s shows X's title (whoever attaches is not mailed) | X's title in `qa-reader`'s |
| 82 | 2153 | Send a request to `qa-reader` naming board B; as `qa-reader`, open Inbox, then Accept | The administrator, then `qa-reader` | No board badge; the dialog starts at "Select a board…" | B's name, or B preselected |
| 83 | 2153 | Send the same request to the administrator; open Inbox | `qa-admin2`, then the administrator | The badge shows B | No badge |
| 84 | 2155 | Open the milestones of the cards check 0o listed (`query-3-before.txt`) | The administrator | Those cards are no longer in them; the others unchanged | A listed card still in its milestone |
| 85 | 2155 | From All Tasks, move a card of a milestone of A to B | The administrator | A toast `Moved. It left milestone "…"; moving it back does not put it back in.`; the card has no milestone; A's activity reads `… moved to board "B" (…) and out of milestone "…"` (`… moved to another board (…) and out of milestone "…"` with card 2181 in the same image); the plan no longer lists it | It keeps the milestone, or no toast |
| 86 | 2155 | The same with a card of a goal across boards | The administrator | It keeps the goal, and no toast about a milestone | It leaves it, or a toast says it did |
| 87 | 2170 | `qa-reader` opens board A and leaves it open. As the administrator, take `qa-reader` off A (Share Board), then change nothing on A for a minute | `qa-reader`; the administrator | Within about 30 seconds `qa-reader`'s page shows "You do not have access to this board"; in their browser's developer tools (Network, the `events` request, EventStream) the last message is `update` with `{"type":"access"}` | The board still on screen after a minute |
| 88 | 2170 | `qa-admin2`, not on A, opens board A. As the superadmin, make `qa-admin2` an ordinary user, then change nothing on A for a minute | `qa-admin2`; the superadmin | The same within about 30 seconds | The board still on screen |
| 89 | 2170 | `qa-reader` has "QA spare" open. As the administrator, delete "QA spare" | `qa-reader`; the administrator | The page shows "Board not found" at once | The board stays |
| 90 | 2170 | `qa-reader` back on A, with A open and left so, for several minutes while the administrator moves cards on A | `qa-reader`; the administrator | Each move appears; nothing else changes | The page goes to a refusal |

Make `qa-admin2` an administrator again if it is kept, and delete the check accounts, boards and schedule afterwards.

#### Going back to the previous image

Nothing is done to the database.

- **0057 stays applied.** The older image logs one `[ERROR] [DB]` line for the recorded file it has no file for, and starts. The cards it took out stay out of their milestones.
- **The rules go with it.** The older image's reports walk into every sub-board again, its refusal and inbox name hidden boards, its "Unblocked" notices carry another board's title, a move leaves a card in its milestone, and an open board stream keeps the access it was opened with.

### The Update That Brings the Third Round of Read Leaks

Six cards go out in one image, and this is the one note for them. Each closes a way for someone to read, or be mailed, something of a board they cannot open, or reaches people a mention could not. No migration and no change of structure; one repair of data at every start, which finds nothing when this goes out with the update before (0057).

- **Card 2179**: `PATCH /api/v1/milestones/{id}` (and the web application's `PATCH /api/milestones/{id}`) gives a milestone to a board only when every card in it, archived ones included, is on that board; otherwise `400` `Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards.` A `boardId` that names no board is `404` `Board not found`. And 0057's statement becomes a third backfill, repeated at every start and after every restore (below).
- **Card 2181**: a move to another board names neither board in its two activity entries (`"T" moved to another board (To Do → Done)` on the board it left, `"T" moved from another board (To Do → Done)` on the one it joined) or in its live events. Entries written before are left as they are.
- **Card 2198**: a comment mails an account it names as `@username` only when that account can open the card's board. The author is told nothing either way.
- **Card 2199**: `GET /api/v1/cards/{id}/board-history` begins with the board a card started on when the card has no recorded creation.
- **Card 2206**: `boardIds` on `GET /api/v1/milestones`, `GET /api/milestones` and the plan page's list holds only boards the caller can open.
- **Card 2207**: a mention is the longest username the text after `@` begins with, in any case, so usernames with capitals, dots, hyphens, spaces or letters outside English can be mentioned; `@jane.doe` no longer mails `jane`, and an email address in a comment no longer mails an account named after its domain.

**The third backfill.** Every start, after the migrations, and every restore or Import Backup, runs 0057's statement again (`CARDS_LEAVE_OTHER_BOARDS_MILESTONES` in `src/lib/server/db/migrate.ts`, held to 0057's text by a test), in the same transaction as the other two backfills: a failure of it stops the start, as theirs does. It is safe to repeat because no write can now put a card in a milestone of another board: putting one in is refused, a move to another board takes it out (card 2155), and a milestone is given to another board only when all its cards are there (card 2179). So it finds cards only after a restore of a backup taken before 0057, or after coming forward again from an older image that was used meanwhile. When it finds any it writes `[WARN] [DB] Took <n> card(s) out of a milestone that belongs to another board: card 12 left milestone 3, …`, and a restore's log line adds `<n> card(s) taken out of a milestone of another board (card 12 left milestone 3, …)` to its "Filled in". Each names the first 50 cards by id, with the milestone each left, and then `; and <n> more`: once a card is out, nothing else records which goal held it. To see every card and goal by name before an Import Backup, copy the backup file into the container (`docker cp <backup file> dumpfire:/tmp/backup.db`) and run check 0o's command with `'/tmp/backup.db'` in place of `process.env.DB_PATH || 'dumpfire.db'`: it opens the file read-only and lists exactly the cards the restore will take out. **A count at any other start means some write still makes such a card**: report it as a fault.

```mermaid
flowchart TD
    Same{"Does this image also bring 0057,<br/>the update before?"}
    Same -->|"Yes"| None["First start: 0057 takes the cards out,<br/>then the backfill finds none"]
    Same -->|"No, 0057 is already on production"| Q3["Run check 0o's query 3 again,<br/>read-only, into query-3-again.txt"]
    Q3 --> Takes["First start: the backfill takes out<br/>exactly the cards it lists, with one WARN line"]
    R["0r to 0u: read-only counts,<br/>on the host"] --> Deploy["Deploy as in Updating a Running Installation"]
    None --> After["Checks 91 to 109"]
    Takes --> After
    Deploy --> Same
```

#### Before the deploy: checks 0r to 0u

None of these changes a ruling; each says how many people a visible change reaches. Run each on the host, against the live database, read-only, as check 0o's command runs: save the query as `query-0r.sql` (and so on), and run that command with `query-0r.sql` in place of `query-3.sql` and `query-0r.txt` in place of `query-3-before.txt`. Shares by team and public boards count as access; administrators can open every board and are left out.

**If the update that brings 0057 is already on production**, run check 0o's query 3 again first, into `query-3-again.txt`, and keep the file: the first start of this image takes exactly the cards it lists out of their milestones (between the two updates a milestone could still be given to another board with its cards, and a backup restored meanwhile could bring such cards back). Settle each card as check 0o says before the deploy. If this image also brings 0057, check 0o is the whole of it.

**Check 0r: moves between boards whose entries name a board that some reader of the other cannot open** (card 2181). The entries already stored stay as they are, so each row is a move whose old entries still show one board's name to readers of the other. A move's two entries are written one after the other, so the arrival is the row after the departure. `readers_of_left_not_joined` counts ordinary users who read the departure and cannot open the board it went to, and the last column the reverse.

```sql
WITH can_open(user_id, board_id) AS (
  SELECT created_by, id FROM boards WHERE created_by IS NOT NULL
  UNION SELECT user_id, board_id FROM board_members
  UNION SELECT tm.user_id, bt.board_id FROM board_teams bt JOIN team_members tm ON tm.team_id = bt.team_id
  UNION SELECT u.id, b.id FROM users u CROSS JOIN boards b WHERE b.is_public = 1
),
moves AS (
  SELECT away.id AS entry_id, away.created_at, away.board_id AS left_id, arrived.board_id AS joined_id
  FROM activity_log away
  JOIN activity_log arrived ON arrived.id = away.id + 1 AND arrived.card_id = away.card_id
   AND arrived.action IN ('card_moved_in', 'api:card_moved_in')
  WHERE away.action IN ('card_moved_away', 'api:card_moved_away')
)
SELECT m.entry_id, m.created_at, bl.name AS left_board, bj.name AS joined_board,
  (SELECT COUNT(*) FROM users u WHERE u.role = 'user'
     AND (u.id, m.left_id) IN (SELECT user_id, board_id FROM can_open)
     AND (u.id, m.joined_id) NOT IN (SELECT user_id, board_id FROM can_open)) AS readers_of_left_not_joined,
  (SELECT COUNT(*) FROM users u WHERE u.role = 'user'
     AND (u.id, m.joined_id) IN (SELECT user_id, board_id FROM can_open)
     AND (u.id, m.left_id) NOT IN (SELECT user_id, board_id FROM can_open)) AS readers_of_joined_not_left
FROM moves m
JOIN boards bl ON bl.id = m.left_id
JOIN boards bj ON bj.id = m.joined_id
WHERE readers_of_left_not_joined > 0 OR readers_of_joined_not_left > 0
ORDER BY m.entry_id;
```

And, into `query-0r-count.txt`, how many departures there are and how many the query above could pair with their arrival; a difference is a move recorded some other way, which it does not list:

```sql
SELECT
  (SELECT COUNT(*) FROM activity_log WHERE action IN ('card_moved_away', 'api:card_moved_away')) AS departures,
  (SELECT COUNT(*) FROM activity_log away
     JOIN activity_log arrived ON arrived.id = away.id + 1 AND arrived.card_id = away.card_id
      AND arrived.action IN ('card_moved_in', 'api:card_moved_in')
   WHERE away.action IN ('card_moved_away', 'api:card_moved_away')) AS paired;
```

**Check 0s: accounts named in comments on boards they cannot open** (card 2198): who was mailed for those comments and would not be from the deploy on. An upper bound: a name is found as `@` and the username anywhere in the text, in any case, so `@jane` also counts in `@janet`.

```sql
WITH can_open(user_id, board_id) AS (
  SELECT created_by, id FROM boards WHERE created_by IS NOT NULL
  UNION SELECT user_id, board_id FROM board_members
  UNION SELECT tm.user_id, bt.board_id FROM board_teams bt JOIN team_members tm ON tm.team_id = bt.team_id
  UNION SELECT u.id, b.id FROM users u CROSS JOIN boards b WHERE b.is_public = 1
)
SELECT u.username, COUNT(*) AS comments, MAX(cc.created_at) AS latest
FROM card_comments cc
JOIN cards c ON c.id = cc.card_id
JOIN columns col ON col.id = c.column_id
JOIN users u ON u.id <> cc.user_id AND instr(lower(cc.content), '@' || lower(u.username)) > 0
WHERE u.role = 'user'
  AND (u.id, col.board_id) NOT IN (SELECT user_id, board_id FROM can_open)
GROUP BY u.username
ORDER BY comments DESC, u.username;
```

**Check 0t: cards whose board history begins on their second board** (card 2199): a recorded move and no recorded creation. From the deploy on, each begins on `started_on`. Keep `query-0t.txt` for check 103.

```sql
SELECT away.card_id,
  (SELECT b.name FROM activity_log f JOIN boards b ON b.id = f.board_id
    WHERE f.card_id = away.card_id AND f.action LIKE '%card_moved_away'
    ORDER BY f.created_at, f.id LIMIT 1) AS started_on,
  COUNT(*) AS departures
FROM activity_log away
WHERE away.action LIKE '%card_moved_away' AND away.card_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM activity_log cr WHERE cr.card_id = away.card_id AND cr.action LIKE '%card_created')
GROUP BY away.card_id
ORDER BY away.card_id;
```

**Check 0u: who a mention could not reach, and who was mailed in another's place** (card 2207), four queries, into `query-0u-1.txt` to `query-0u-4.txt`. The first lists usernames holding anything but lower-case letters, digits and `_`, which a mention could not reach as typed and can from the deploy on:

```sql
SELECT id, username FROM users WHERE username GLOB '*[^a-z0-9_]*' ORDER BY id;
```

The second lists usernames that differ only in case. For such a pair, say `Greg` and `greg`, `@greg` mails `greg` and `@GREG` mails neither from the deploy on; if it lists any, tell both accounts:

```sql
SELECT lower(username) AS name, COUNT(*) AS accounts, group_concat(username, ', ') AS spellings
FROM users GROUP BY lower(username) HAVING COUNT(*) > 1 ORDER BY name;
```

The third lists, for each username that holds a character the old matcher stopped at, the account named by the part before it, if there is one: `mailed_today` was mailed in place of `named`, and from the deploy on `named` is mailed instead:

```sql
SELECT b.username AS named, a.username AS mailed_today
FROM users a JOIN users b
  ON b.id <> a.id
 AND lower(substr(b.username, 1, length(a.username))) = a.username
 AND substr(b.username, length(a.username) + 1, 1) GLOB '[^A-Za-z0-9_]'
WHERE a.username NOT GLOB '*[^a-z0-9_]*'
ORDER BY b.username;
```

The fourth lists the accounts a longer name may now take a mention from: `swallowed` is a username, and `longer` another account's username that begins with it, in any case, followed by a character that ends a name (a space, or a mark such as `'` or `!`, but not `.` or `-` before a letter or digit). The longest name wins, so `@jane Doe` written for `jane`, before the word "Doe", mails `Jane Doe`, and `@o'brien` mails `o'brien`, not `o`. Tell the `swallowed` account of each row, if it matters. It compares case for the letters A to Z only, as SQLite's `lower()` does, and takes any character outside ASCII as a letter:

```sql
SELECT a.username AS swallowed, b.username AS longer
FROM users a JOIN users b
  ON b.id <> a.id
 AND length(b.username) > length(a.username)
 AND lower(substr(b.username, 1, length(a.username))) = lower(a.username)
WHERE unicode(substr(b.username, length(a.username) + 1, 1)) < 128
  AND substr(b.username, length(a.username) + 1, 1) GLOB '[^A-Za-z0-9_]'
  AND NOT (substr(b.username, length(a.username) + 1, 1) IN ('.', '-')
       AND (substr(b.username, length(a.username) + 2, 1) GLOB '[A-Za-z0-9_]'
            OR coalesce(unicode(substr(b.username, length(a.username) + 2, 1)), 0) >= 128))
ORDER BY a.username, b.username;
```

**In the rehearsal (check 0c)**, if one is run, `Filled in:` names a third count, `<n> card(s) taken out of a milestone of another board`, with the first 50 of them on the next line when there are any; it is 0 unless check 0o's query 3 lists cards on the copy and 0057 is already applied there: when 0057 ships in the same image, the migration takes them out first and the backfill finds none. No migration file is added, so no other line changes.

#### What changes at the first start

- **The third backfill runs.** With 0057 in the same image it finds nothing, and nothing is logged for it. With 0057 already on production it takes out of their milestones exactly the cards `query-3-again.txt` lists, leaves `updated_at` as it is, writes no activity entry, and logs `[WARN] [DB] Took <n> card(s) out of a milestone that belongs to another board: card <id> left milestone <id>, …` (the first 50; `query-3-again.txt` has them all). A later start finds nothing.
- **Through the API**: a milestone with cards of another board is refused a new `boardId` (`400`); a `boardId` that names no board is `404` for everyone. `boardIds` lists only boards the key's user can open. A card's board history may begin one board earlier. The activity entries of a move between boards, in the audit log, name neither board.
- **On the pages**: a board's Activity and All Tasks show `"T" moved to another board (…)` and `"T" moved from another board (…)` for moves from now on, each under its own board in All Tasks. A mention chip and the mention mail follow the new rule: a name with capitals, dots or hyphens is chipped and mailed whole.
- **By mail**: someone named in a comment on a board they cannot open is not mailed.
- **No structure changes**, so the schema check has nothing new to say.

**Owner to know.** Through the API a goal can no longer be given to another board while any card in it, archived ones included, is on a board other than that one; making it cross-board still works, and no page sends `boardId`. Anyone who sends a board id that does not exist is answered `404` `Board not found`, where an administrator was answered `500` and anyone else `403`. A backup taken before 0057, restored after this update, comes back with its cards that sit in a milestone of another board taken out of it, and the restore's report says how many. If this update goes out after the one that brings 0057, its first start takes out of their milestones every card then sitting in a milestone of another board, and logs how many (`query-3-again.txt` lists them). A move between boards no longer names the other board in either board's activity, for anyone: to see where a card went, All Tasks shows both entries under their boards. Entries written before the deploy still name the other board (check 0r lists them). Someone named in a comment on a board they cannot open is no longer mailed (check 0s). The board history of a card with no recorded creation begins with the board it started on (check 0t). `boardIds` no longer gives the id of a board the caller cannot open; an administrator's answer is unchanged. A mention reaches usernames with capitals, dots, hyphens, spaces and letters outside English; `@jane.doe` no longer mails `jane`, an email address in a comment no longer mails an account named after its domain, and of two usernames that differ only in case only the one typed exactly is mailed (check 0u's second query). A mention written for a name that begins another account's longer name, before the rest of it, now mails the longer one (its fourth).

#### After the deploy

Checks 91 to 109 run on production. Accounts: an administrator with an API key, an ordinary user `qa-reader` and an ordinary user `qa-both`, each in a browser of their own. Data: two test boards made by the administrator, "QA Alpha" and "QA Bravo"; `qa-reader` a member of QA Alpha only, `qa-both` a member of both; for check 107 an ordinary user `QA.Dot-Case`, a viewer of QA Alpha. Mail set up; the test users' mailboxes readable, with the "Card Moves" and "Mentions" mail preferences on. In Windows PowerShell 5.1 send each request with `curl.exe`, its body from a file as in checks 51 to 71, and `-w " %{http_code}\n"` so that the status follows the answer, as check 64 does. The method changes from check to check (`POST` in 91, 101 and 105, `PATCH` in 91 to 94, `DELETE` in 93 and 106, `GET` in 103 and 104), so each command is given here: `<key>` is the administrator's API key, and where there is a body, put it in `body.json` first.

- **Check 91**: `curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones` with `{"name":"QA goal","boardId":<QA Bravo id>}`; then `curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones/<milestone id>/cards` with `{"cardId":<card id>}`; then `curl.exe -s -w " %{http_code}\n" -X PATCH -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones/<milestone id>` with `{"boardId":<QA Alpha id>}`, and `curl.exe -s -w " %{http_code}\n" -H "Authorization: Bearer <key>" https://<host>/api/v1/milestones/<milestone id>` to read it back.
- **Checks 92 and 94**: `curl.exe -s -w " %{http_code}\n" -X PATCH -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones/<milestone id>` with each body in turn.
- **Check 93**: `curl.exe -s -w " %{http_code}\n" -X DELETE -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones/<milestone id>/cards` with `{"cardId":<card id>}`; then check 92's command with `{"boardId":<QA Alpha id>}`; then `curl.exe -s -w " %{http_code}\n" -X DELETE -H "Authorization: Bearer <key>" https://<host>/api/v1/milestones/<milestone id>`, with no body, to delete it.
- **Check 101**: `curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/cards/<QA Bravo card id>/comments` with `{"content":"@qa-reader check 101"}`.
- **Checks 103 and 104**: `curl.exe -s -w " %{http_code}\n" -H "Authorization: Bearer <key>" https://<host>/api/v1/cards/<card id>/board-history`, a `GET`, with no `-X` and no body.
- **Check 105**: `curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones` with `{"name":"QA across"}`; then `curl.exe -s -w " %{http_code}\n" -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d "@body.json" https://<host>/api/v1/milestones/<milestone id>/cards` twice, with `{"cardId":<QA Alpha card id>}` and then `{"cardId":<QA Bravo card id>}`.
- **Check 106**: the milestone is deleted with check 93's last command.

`/api/milestones` opened in a signed-in browser shows the answer as JSON.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 91 | 2179 | Make a milestone of QA Bravo with one card of QA Bravo in it (`POST /api/v1/milestones` with `{"name":"QA goal","boardId":<QA Bravo id>}`, then `POST /api/v1/milestones/<id>/cards` with `{"cardId":<card id>}`). `PATCH` it with `{"boardId":<QA Alpha id>}` | The administrator's key | `400` `{"message":"Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first, or make the milestone cross-board instead; only its creator or an administrator can change a cross-board milestone afterwards."}`; `GET /api/v1/milestones/<id>` still has QA Bravo's id | `200` |
| 92 | 2179 | The same milestone: `{"boardId":null}`, then `{"boardId":<QA Bravo id>}` | The administrator's key | Both `200`: across boards, then back to QA Bravo | Either refused |
| 93 | 2179 | Take the card out (`DELETE /api/v1/milestones/<id>/cards` with `{"cardId":<card id>}`), then `{"boardId":<QA Alpha id>}`. Then delete the milestone | The administrator's key | `200`, and its `boardId` is QA Alpha's | Refused |
| 94 | 2179 | `{"boardId":999999}` on any milestone | The administrator's key | `404` `{"message":"Board not found"}` | `500` |
| 95 | 2180 | Assign `qa-reader` and `qa-both` to a card of QA Alpha. Move it to QA Bravo from All Tasks (Move) | The administrator | `qa-both` is mailed "Card moved", naming QA Bravo; `qa-reader` is not | A mail to `qa-reader` |
| 96 | 2181 | After check 95, open QA Alpha's Activity | `qa-reader` | `… moved to another board (… → …)`, with no "QA Bravo" | "QA Bravo" in it |
| 97 | 2181 | Open All Tasks' activity | `qa-both` | Both entries, one under QA Alpha and one under QA Bravo | Either missing |
| 98 | 2181 | With QA Alpha open, developer tools, Network, the `events` request, EventStream, while the administrator moves another card from QA Alpha to QA Bravo | `qa-reader`; the administrator | The `update` with `"action":"moved_away"` has no `toBoard` and no board name | A board name in it |
| 99 | 2181 | Look at a move between boards made before the deploy, in a board's Activity | The administrator | It still names the other board: entries already stored are left as they are | — |
| 100 | 2198 | Comment on a card of QA Bravo: `@qa-reader and @qa-both, check 100` | The administrator | `qa-both` is mailed "… mentioned you: …"; `qa-reader` gets nothing | A mail to `qa-reader` |
| 101 | 2198 | `POST /api/v1/cards/<QA Bravo card id>/comments` with `{"content":"@qa-reader check 101"}` | The administrator's key | `201`; no mail to `qa-reader` | A mail |
| 102 | 2198 | Comment `@qa-reader check 102` on a card of QA Alpha | The administrator | `qa-reader` is mailed: the positive control | No mail |
| 103 | 2199 | Pick a card from `query-0t.txt` that is still on a board; `GET /api/v1/cards/<id>/board-history` | The administrator's key | The first span is on its `started_on`, with `current: false`; the last is the card's board, with `current: true` | It begins on the card's second board |
| 104 | 2199 | The board history of check 95's card, made after the deploy and moved to QA Bravo | The administrator's key | QA Alpha, then QA Bravo, each once | QA Alpha twice, or missing |
| 105 | 2206 | Make a milestone across boards (`POST /api/v1/milestones` with a name only) and put a card of QA Alpha and one of QA Bravo in it. Open `/api/milestones` | The administrator's key; then `qa-both` | Its `boardIds` holds both boards' ids | Either is missing |
| 106 | 2206 | Open `/api/milestones`. Then delete check 105's milestone | `qa-reader`; the administrator | That milestone is not listed (a goal across boards needs every board, as before); QA Alpha's milestones list QA Alpha's id alone | QA Bravo's id anywhere in the answer |
| 107 | 2207 | Comment on a card of QA Alpha: `@qa.dot-case check 107` | The administrator | `QA.Dot-Case` is mailed "… mentioned you"; the card shows one chip covering `@qa.dot-case` | No mail, or a chip on `@qa` alone |
| 108 | 2207 | Comment `@qa-reader. check 108, and @qa-readers` | The administrator | `qa-reader` is mailed once; the chip covers `@qa-reader`, and `@qa-readers` has no chip | No mail, or a chip on `@qa` |
| 109 | 2207 | Comment `write to someone@qa-reader.test` | The administrator | Nobody is mailed "mentioned you", and there is no chip | A mention mail, or a chip |

Check 95 is card 2180's, built with the completion update: it is listed here because no earlier list moves a card to another board. Card 2179's repair after a restore is not checked by hand: production is not restored for a check, the tests cover it, and the rehearsal prints its count. Delete `QA.Dot-Case`, the check comments' cards and the test boards afterwards.

#### Going back to the previous image

Nothing is done to the database: no migration was applied.

- **The rules go with it.** The older image gives a milestone to another board with its cards, writes the other board's name into a move's entries and events, mails anyone a comment names by the old matcher, begins a board history on the second board, and lists every board in `boardIds`. Entries written by this image say "another board" and stay so.
- **Coming forward again**, the third backfill takes out of their milestones the cards the older image left in a milestone of another board, and logs how many.

### The Update That Brings Migration 0058 and Report Schedules Sent Once and On Time

Two cards go out in one image, and this is the one note for them, with the after-deploy checks of the two that shipped before them in the same plan (cards 2149 and 2156, names escaped in report mail and the limit on a requester's replies). One migration, no value changed. **Run check 0v before 25 October 2026**: its cross-check only works while British summer time lasts.

- **Card 2144**: the scheduler works a schedule's next run out before it sends, and claims the run with one conditional write before the report is built, so a run is sent at most once: never again by the next tick when a slow mail server holds a run past the minute, nor by a second process. A schedule whose next run cannot be worked out (a time such as `9`, a weekly day of `-2` or `7`, a frequency other than weekly or monthly) is switched off at its next due minute with one `ERROR` line, and nothing is sent; it was sent at every minute's tick. A schedule with no next run is given one and sent nothing. The start never throws for a schedule: one with no next run and an unreadable time used to stop the server starting.
- **Card 2159** brings migration `0058_add_report_schedule_time_zone.sql`, a column `report_schedules.time_zone`: each schedule's time is read in its own zone, an IANA name such as `Europe/London`, all year. The Reports page sends its creator's browser zone with a new schedule, shows the zone in the badge ("at 09:00 Europe/London"), writes Last and Next in the schedule's zone, and offers **Use my time zone (Europe/London)** on a schedule whose zone is not the viewer's. A `PUT` that turns a schedule on, or changes its frequency, day, time or zone, works its next run out again from now: turning one back on no longer sends it at once for a run missed while it was off, and a changed time no longer sends the old one once more.

0058 is one statement. It keeps every row and gives each the literal, `UTC`, the zone the image runs in (it sets no `TZ`), so every schedule that exists is sent at exactly the moments it was:

```sql
ALTER TABLE `report_schedules` ADD COLUMN `time_zone` text DEFAULT 'UTC' NOT NULL;
```

The same literal is the model's default (`schema.ts`) and the zone of a schedule made through the route with none (`DEFAULT_SCHEDULE_TIME_ZONE`). If production runs in another zone, the image is not deployed as it is: the literal is changed in all three places and the image rebuilt, or every schedule moves by the difference. Check 0v says which.

```mermaid
flowchart TD
    V["0v: the zone the server runs in, and query 1,<br/>before 25 October 2026"] --> Same{"UTC?"}
    Same -->|"No"| Stop["Do not deploy. Change the literal in 0058,<br/>schema.ts and report-schedule-time.ts, rebuild"]
    Same -->|"Yes"| W["0w: query 2, schedules the scheduler cannot date"]
    W --> X["0x: query 3, a requester's busiest hour"]
    X --> Y["0y: the rehearsal lists 0058"]
    Y --> Deploy["Deploy as in Updating a Running Installation"]
    Deploy --> First["First start: 0058 applied, every schedule UTC,<br/>query 2's rows switched off at their next due minute,<br/>or at once with no next run or a NaN one"]
    First --> After["Checks 110 to 123, the last on 29 March 2027"]
    After --> Owners["Each owner presses Use my time zone<br/>on each schedule that should follow UK time"]
```

#### Before the deploy: checks 0v to 0y

Each runs on the host, against the live database, read-only. Save a query as `query-0v.sql` (and so on) and run it with this command, which opens the database read-only and writes the table to a file, since it is wider than a terminal:

```bash
docker exec -i dumpfire node -e "
const sql = require('fs').readFileSync(0, 'utf8');
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare(sql).all());
db.close();
" < query-0v.sql > query-0v.txt
```

**Check 0v: the zone production's schedules run in** (card 2159). First the zone the server process runs in; it decides:

```bash
docker exec dumpfire node -e "console.log(process.env.TZ || '(TZ not set)', Intl.DateTimeFormat().resolvedOptions().timeZone)"
```

Expect `(TZ not set) UTC` (or `Etc/UTC` in place of `UTC`, which is the same zone). Anything else, `Europe/London` above all (a `TZ` set on the container, or the host's `/etc/localtime` mounted into it), means the literal in 0058 is wrong for production: stop, and do not deploy this image.

Then query 1, the cross-check, which reads what the schedules have actually done. It only works on a date in British summer time, so run it **before 25 October 2026**:

```sql
SELECT id, name, enabled, frequency, day_of_week, day_of_month, time_of_day,
       next_run_at, strftime('%H:%M', next_run_at) AS next_run_utc,
       last_run_at, strftime('%H:%M', last_run_at) AS last_run_utc
FROM report_schedules
ORDER BY id;
```

For each row with a `last_run_at` (or `next_run_at`) on a date before 25 October 2026: where `last_run_utc` is `time_of_day`, or a minute after it at most, the server runs on UTC; where it is an hour earlier, it runs on UK time. A `next_run_at` on 25 October or later says nothing either way. It is a fault if the rows say UK time, or if the two lines disagree; either way, do not deploy as it is. An empty table means there is nothing to move, and the zone line decides alone.

**Check 0w: query 2, schedules the scheduler cannot date** (card 2144). Each row is a schedule whose next run cannot be worked out. Each one that is enabled is switched off at its next due minute after the deploy (or at the first start, if it has no next run or one that cannot be read), with one `ERROR` line naming it and its owner, and sends nothing; turning it on is then refused, unless the same `PUT` sends a time, day and zone that can be read. Today some of these are sent at every minute's tick; others (`9:5`, `09:00:00`, a weekly day of `7`) are sent at a time today's code guesses.

```sql
SELECT id, user_id, name, enabled, frequency, day_of_week, day_of_month, time_of_day, next_run_at
FROM report_schedules
WHERE frequency NOT IN ('weekly', 'monthly')
   OR NOT (time_of_day = '' OR time_of_day GLOB '[01][0-9]:[0-5][0-9]' OR time_of_day GLOB '2[0-3]:[0-5][0-9]')
   OR (frequency = 'weekly' AND (typeof(day_of_week) <> 'integer' OR day_of_week NOT BETWEEN 0 AND 6))
   OR (frequency = 'monthly' AND (typeof(day_of_month) <> 'integer' OR day_of_month < 1));
```

Expect an empty table: no page writes such a timing. A row whose `next_run_at` reads `NaN-NaN-NaN NaN:NaN:NaN` was written by the image before this one for a time it could not read (one more mail, then that); under that image it is never due, so it is neither sent nor switched off, and the start-up conversion names it at every start. This image reads a next run that cannot be read as none: at the first start such a row is switched off (its `ERROR` line written if it was on) and its `next_run_at` cleared, so the conversion names it at that start and at none after. For each row, tell its owner (`user_id`) before the deploy: they put it right through `PUT /api/report-schedules/{id}` (a `timeOfDay` of `HH:MM`, a `dayOfWeek` from 0 to 6) or delete it and make it again, or it is accepted that the deploy switches it off. Switched off, it can still be turned on by its owner with a `PUT` that sends `enabled: true` and a timing that can be read, such as `{"enabled": true, "timeOfDay": "10:00"}`.

**Check 0x: query 3, a requester's busiest hour** (card 2156, already on production). The most replies a requester has sent to one request within any hour, from each of their replies. The limit is 20 an hour, cleared by a reply from the team; it is a fault if any count is above 10, because a genuine thread then comes near it: raise `REPLIES_PER_HOUR` in `src/routes/api/requests/[id]/messages/+server.ts` to twice the highest.

```sql
SELECT a.request_id, a.created_at AS from_reply, COUNT(b.id) AS replies_in_the_hour
FROM request_messages a
JOIN request_messages b
  ON b.request_id = a.request_id
 AND b.sender_type = 'requester'
 AND b.created_at >= a.created_at
 AND b.created_at < datetime(a.created_at, '+1 hour')
WHERE a.sender_type = 'requester'
GROUP BY a.id
ORDER BY replies_in_the_hour DESC
LIMIT 10;
```

**Check 0y: the rehearsal.** `npm run rehearse -- <export.db>` on an Admin Export copy, with the new code, as check 0c runs it (see [Testing](testing.md#rehearsing-the-runner-against-a-copy-of-a-real-database)). Expect `0058_add_report_schedule_time_zone.sql` among the files applied, `PASSED`, no schema difference, and the row count of `report_schedules` unchanged; nothing under `Worth knowing` for it, since it is no one-off. It is a fault if it prints `FAILED`, or a difference naming `report_schedules`.

#### What changes at the first start

- **0058 is applied**: `[WARN] [DB] Applied migration: 0058_add_report_schedule_time_zone.sql`. Every schedule reads `UTC`, and its `next_run_at` and `last_run_at` are as they were.
- **The scheduler starts and never throws.** Each schedule with no next run, or with one that cannot be read (`NaN-NaN-NaN NaN:NaN:NaN`), is given one; one of query 2's rows among them is switched off then, with its `ERROR` line if it was on, and a next run that could not be read is cleared. Each other row of query 2 that is enabled is switched off at its next due minute.
- **On the Reports page**: every existing schedule reads "at 09:00 UTC", Last and Next in UTC, unchanged in moment, and offers **Use my time zone (Europe/London)** to a viewer in the UK, with a line under it saying what it does; while UK summer time lasts, Next is followed by the time in the viewer's zone ("Next: 26 Oct 2026, 09:00 UTC" in winter, "(10:00 your time)" after it in summer). A schedule the scheduler cannot date shows "Cannot be sent: …" in place of Next, and no zone button.
- **No answer of the v1 API changes; the Reports page and the web application's schedule routes do.** `GET /api/report-schedules` and the two schedule routes answer `timeZone` with each schedule, and `POST` and `PUT` take it. They have two new `400`s: `timeZone must be a time zone name, such as Europe/London`, and a timing the scheduler cannot date (`The schedule was not saved: …`, `The schedule was not changed: …`, `This schedule cannot be turned on: …`). A `PUT` that turns a schedule on, or re-times it, answers with its next run worked out again from now.

**Owner to know.**

- **Existing schedules keep arriving an hour late in British summer time until each is moved.** Only a schedule's owner can see it or change it, so each user with a schedule presses **Use my time zone** on each one that should follow UK time; an administrator cannot do it for them. British summer time ends on 25 October 2026, so a schedule left in UTC arrives on time in the UK through the winter: **press it before 28 March 2027, when UK summer time starts again** (a Monday schedule left in UTC is first an hour late on Monday 29 March). Check 123 is on that date.
- **A schedule made on the page is sent at the time shown, in its creator's zone, all year.**
- **Turning a schedule back on sends it at its next time**, never at once for a run missed while it was off. That includes every schedule turned back on after a working-copy restore, which turns them all off, and after a password reset, which pauses them.
- **At most once.** A run is claimed before its report is built, so a restart during its sends (a deploy at the minute a schedule is due) loses the rest of that run; it is not sent again. Before, the whole run was sent again to everyone at the next start.
- **A new zone takes the schedule's addresses from the account's 100 a day**, as a new time does: like a new time, it can bring a send forward to any time, the next minute included. A schedule that is off after the change takes nothing; turning it on pays then.

#### After the deploy

Checks 110 to 123 run on production unless marked **local**. A local check runs against a local instance started with `DB_PATH` set to a scratch file and its own mail settings, never production's database or mail; check 121 needs `SCHEDULERS=on` as well, because the schedulers are off under the dev server without it. Accounts: the owner of each existing schedule; an administrator; a second account that follows a board. Mail set up, to your own address; a scratch board.

| # | Card | Do | Account and data | Expect | A fault if |
|---|---|---|---|---|---|
| 110 | 2144, 2159 | The **Audit** page's system log, right after the start | An administrator | `Applied migration: 0058_add_report_schedule_time_zone.sql` and `Report scheduler initialized`; no `ERROR` from `REPORTS`, except one per row of query 2 that had no next run | A `RangeError`, or the server does not start |
| 111 | 2159 | **Reports**, **Schedules**, as the owner of an existing schedule | Each owner | "at 09:00 UTC"; Next in UTC and the same moment as before; **Use my time zone (Europe/London)** under it | No zone shown, or Next moved |
| 112 | 2159 | Press **Use my time zone** on each schedule that should follow UK time | The same | The badge says Europe/London; Next is written in UK time and, before 25 October 2026, is an hour earlier than before | An error, or Next unchanged before 25 October |
| 113 | 2144, 2159 | Make a scratch schedule, weekly for today, three minutes from now by your clock, to your own address, on the scratch board; wait | Mail set up; the scratch board | One mail, at that time by your clock | An hour late, two mails, or none |
| 114 | 2159 | Turn that schedule off and on again | The same | No mail at once; Next is the same time next week | A mail at once |
| 115 | 2149 | Rename the scratch board to `R&D <b>bold</b> <a href="#x">link</a>` and email its report to yourself from **Generate** | The same | The mail shows the name as typed, angle brackets and all, with no bold and no link; the subject shows it as typed | Bold text or a link in the mail |
| 116 | 2149 | Make a second scratch schedule named `R&D <b>bold</b> <a href="#x">link</a>`, three minutes ahead, to your own address | The same | The scheduled mail shows the name as text | Markup drawn |
| 117 | 2149 | Comment on a card of a board the second account follows | The second account | Their mail looks as before, and its "View Task" link opens the card | A broken link, or `&amp;` shown |
| 118 | 2159 | On 26 October 2026, after the clocks go back | Check 112's schedules | A weekly Monday 09:00 Europe/London schedule arrives at 09:00 GMT | 08:00 or 10:00 |
| 119 | 2159 | Open the Reports page in a browser whose zone is UTC (or any other), on a schedule in Europe/London | Any owner | The badge still says Europe/London, Next is in UK time with `GMT` or `BST`, and the button reads **Use my time zone (UTC)** | Next in the browser's zone |
| 120 | 2156 | **Local.** As a requester with a request's link, send 21 replies within an hour | A local request and its link | Twenty saved and mailed; the 21st says "Too many replies to this request in the last hour. Try again in N minute(s).", and the text stays in the box | The 21st saved or mailed, or the text cleared |
| 121 | 2144 | **Local**, with `SCHEDULERS=on`. In the scratch database, set one schedule's `time_of_day` to `9` and its `next_run_at` to the past, and a second's `time_of_day` to `9` and its `next_run_at` to `NaN-NaN-NaN NaN:NaN:NaN`; wait a minute | Two local schedules | One `ERROR` line naming each; on the Reports page both are off, with "Cannot be sent: its time of day "9" …" and no **Use my time zone**; the second's `next_run_at` is empty; no mail; turning one on is refused with the reason | A mail, an `ERROR` line each minute, or the second still on |
| 122 | 2149 | **Local.** A backup destination named `<b>x</b>` with a host that does not exist, "notify on failure" on, **Run Backup Now** | The local superadmin | The failure mail shows the name and the error as text | Markup drawn |
| 123 | 2159 | On Monday 29 March 2027, after the UK's clocks went forward the day before | Check 112's schedules, and any schedule left in UTC | A weekly Monday 09:00 Europe/London schedule arrives at 09:00 BST; one left in UTC arrives at 10:00 BST, and its owner presses **Use my time zone** on it | The moved schedule at 08:00 or 10:00 |

Delete the two scratch schedules and the scratch board after check 116.

#### Going back to the previous image

Nothing is done to the database.

- **0058 stays applied.** The older image logs one `[ERROR] [DB]` line for the recorded file it has no file for, and its schema check one for the column its model lacks, and starts. It neither reads nor writes `time_zone`: it reads every schedule's time on the server's clock again (UTC), and a schedule it makes is given `UTC` by the column's default.
- **The old order comes back**: a run is sent again by a tick that meets it while it is still sending, a schedule it cannot date is sent at every tick, and turning one on sends it at once.
- **Coming forward again**, a schedule moved to Europe/London is read in Europe/London again; one made by the older image reads in UTC.

### Notices on Cards Moved Before Card 2256

Card 2256 rewrites a card's "Unblocked" notices when the card moves to another board, so that they name no work of the board it left (see [Authentication & Security](authentication-security.md), "Unblocked"). It leaves alone the notices of cards moved before it is deployed: such a notice may still name, by its title, a card or a subtask of the board the card left, to readers of the board it is on now. These two queries find them. Run each once, on the host, against the live database, read-only, before the deploy of the image that brings card 2256. Nothing in the deploy depends on the answer.

Save the first as `query-2256-card.sql` and the second as `query-2256-subtask.sql`, and run each with this command, which opens the database read-only and writes the table to a file:

```bash
docker exec -i dumpfire node -e "
const sql = require('fs').readFileSync(0, 'utf8');
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare(sql).all());
db.close();
" < query-2256-card.sql > query-2256-card.txt
```

and again with `query-2256-subtask.sql` and `query-2256-subtask.txt`. Each query is one `SELECT`, and the database is opened read-only, so neither can change anything.

The card form, `query-2256-card.sql`: notices naming, by title, a card on a board other than the one their own card is on now.

```sql
-- Card 2256: Unblocked notices naming, by title, a card on another board than their own card's.
-- Read-only: one SELECT. 'Unblocked: #' is 12 characters, so the id starts at character 13.
SELECT cc.id AS comment_id, cc.card_id, co.board_id AS card_board,
       bc.board_id AS named_card_board, substr(cc.content, 1, 120) AS content
  FROM card_comments cc
  JOIN cards c    ON c.id = cc.card_id
  JOIN columns co ON co.id = c.column_id
  JOIN cards b    ON b.id = CAST(substr(cc.content, 13, instr(substr(cc.content, 13), ' ') - 1) AS INTEGER)
  JOIN columns bc ON bc.id = b.column_id
 WHERE cc.content LIKE 'Unblocked: #% "%" completed — nothing is blocking %'
   AND bc.board_id <> co.board_id
 ORDER BY cc.id;
```

The subtask form, `query-2256-subtask.sql`: a subtask's notice names no id, so it finds notices naming a subtask by title on a card that arrived from another board after the notice was written.

```sql
-- Card 2256, the subtask form: notices naming a subtask by title on a card that
-- arrived from another board after the notice was written. Read-only: one SELECT.
SELECT cc.id AS comment_id, cc.card_id, substr(cc.content, 1, 120) AS content
  FROM card_comments cc
 WHERE cc.content LIKE 'Unblocked: subtask "%" completed — nothing is blocking %'
   AND EXISTS (SELECT 1 FROM activity_log al
                WHERE al.card_id = cc.card_id
                  AND al.action IN ('card_moved_in', 'api:card_moved_in')
                  AND al.created_at >= cc.created_at)
 ORDER BY cc.id;
```

**What a row means.** Each row is one comment (`comment_id`, on card `card_id`) that names work by its title where some readers of its card's board may not be able to open that work. In the card form, `card_board` is the board the card is on and `named_card_board` the board of the card it names; it also lists a notice whose own card stayed where it was while the card it names moved away later, which card 2261 rewrites for a move made once it is deployed but not for one made before, so a row is one case or the other. A notice naming a card since deleted is not listed. In the subtask form, a row may name one of the card's own subtasks, which moved with it and can be read on it: that one is harmless. The subtask form finds a card by the move logged when it arrived; before 14 September 2026 only a move through the API logged that, so a card moved before then by the board page is not found by it. Expect no rows, or a few. Keep both files where only an administrator can read them: they hold the text of notices from every board.

**A row can be left.** The update rewrites none of these notices and changes nothing for them: each reads as it did before the deploy. A one-off rewrite of the rows found would change stored comments, and would be its own card, not part of this deploy.

### A Google Drive Connect Finished Only by the Session That Started It

**Card 2251.** No migration, no setting and no value changes. Connect on a Google Drive destination with OAuth now puts a random `state` and a PKCE challenge (`code_challenge`, `code_challenge_method=S256`) in Google's consent address, and takes the address pasted back only from the same browser session, signed in as the same superadmin, for the same destination, within ten minutes and once; the code goes to Google with the PKCE verifier. Until now it took any code, so a code from somebody else's consent, pasted by a superadmin led to, connected that person's Google account. See [Authentication & Security](authentication-security.md) (the superadmin's routes) and [Backups & Reporting](backup-reporting.md) (Google Drive's scope and folder).

**Owner to know.**

- **Paste the whole address.** The page refuses a bare code, which it used to take: "Paste the whole address from the browser's address bar: it holds the code and the check that this connection was started here." An address holding `error=access_denied` (consent refused in Google's window) is said and not sent.
- **A refused address** answers "This connection was not started from this session, or has expired or been used. Press Connect again, and paste the whole address Google's page leads to.", with one `[WARN] [GDRIVE] Google Drive Connect refused for destination "…"` line on the Audit page. Press Connect and start again.
- **A deploy or restart ends a Connect under way**: the Connects are held in memory. Press Connect again.
- **Reload any admin page left open from before the deploy before connecting.** A tab loaded before it sends no state, and every paste from it is refused.
- **Connections already made keep working** and are not checked again. No destination needs to be connected again because of this deploy.
- **Google must accept PKCE for this OAuth client** (check 125). The client's secret is still sent with the code, as before; whether Google accepts the verifier with it for this client's type cannot be tried from the development machine, where Google is stood in for. If Google refuses the verifier, no new Connect can be made until that is resolved; existing connections are unaffected.

#### After the deploy

Checks 124 to 129 run on production as the superadmin, on a Google Drive destination with OAuth that is **not yet connected**: add a scratch destination for them (any name, the same client ID and secret as the real one, the Folder ID empty), and remove it afterwards, with the folder Connect makes in the account's My Drive. Do not use the real destination: once connected, it shows no Connect button. Have the client ID and secret from the Google Cloud console to hand: check 126 adds the destination again, and the page masks the secret. Run the checks away from the scheduled backup time: while the scratch destination is unconnected a scheduled run fails for it (and sends its failure email if notify-on-failure is on), and between checks 125 and 126 it is connected, so a scheduled run would upload a full copy of the database into its folder.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 124 | 2251 | **🔗 Connect** on the scratch destination; in the consent window, before approving, look at the address | `state=` a long random value, `code_challenge=` and `code_challenge_method=S256` | `state=` the destination's name, or no challenge |
| 125 | 2251 | **Does Google accept PKCE for this OAuth client type?** Approve, copy the whole address of the page Google leads to (`http://localhost/?state=…&code=…`) and keep a copy of it (for example in a text editor) for check 127, paste it, ✅ Connect | "Google Drive connected. DumpFire made the folder …": Google accepted the verifier for this client | `invalid_grant`, or any message naming a code verifier or `code_challenge`: Google refuses PKCE for this OAuth client type. Stop and report it with the client's type (Google Cloud console, Credentials: "Desktop app" or "Web application"); the design's PKCE half is then revisited |
| 126 | 2251 | Remove the scratch destination and add it again (still not connected); Connect, approve, and paste only the value after `code=` | The page refuses: "Paste the whole address from the browser's address bar: …"; nothing is sent | Sent, or connected |
| 127 | 2251 | Paste the address from check 125 again (Connect pressed first, the box open) | "This connection was not started from this session, or has expired or been used. …"; one `[WARN] [GDRIVE] Google Drive Connect refused …` line on the Audit page, filed under your account with `{"stateSent":true}` | Connected |
| 128 | 2251 | Connect, wait eleven minutes, then approve and paste the address | The same refusal | Connected |
| 129 | 2251 | Connect and approve in one browser; in a second browser signed in as the same superadmin, press Connect, close its consent window, and paste the first browser's address there | The same refusal | Connected |

Then remove the scratch destination, and in Google Drive delete the scratch folder check 125 made.

#### Going back to the previous image

Nothing is done to the database. The older image builds a consent address with the destination's name as its `state` and no challenge, and takes any code again; a connection made under either image works under both.

### An SFTP Destination's Host Key, Confirmed and Checked at Every Connect

**Card 2250.** No migration and no setting. An SFTP backup destination now holds its server's host key, `hostKey`, as one more field of the destination in the `backup_config` setting's JSON (`ssh-ed25519 SHA256:<43 characters>`). Every connect (Test, a backup, retention's listing and deleting) asks the server for a key of that type only and refuses any other key inside the key exchange, before a password or private key is used; a destination with no key confirmed is sent nothing. Until now an SFTP destination connected to whatever answered for its host, and sent it the password and then the backup. See [Configuring Backups](admin-guide.md#configuring-backups) in the admin guide, [Backups & Reporting](backup-reporting.md) (the host key) and [Authentication & Security](authentication-security.md) (the superadmin's routes).

```mermaid
flowchart LR
    Deploy["Deploy"] --> Line["Start-up line names<br/>each SFTP destination"]
    Line --> Test["🧪 Test: the key presented,<br/>nothing sent"]
    Test --> Check["ssh-keygen -lf on the server:<br/>the same SHA256:…"]
    Check --> Confirm["✅ Confirm this key:<br/>saved, Test runs again"]
    Confirm --> Backups["Backups go to it again"]
```

**Owner to know.**

- **Every SFTP destination stops receiving backups at the deploy, until its key is confirmed.** None has a key yet, so each scheduled run fails each SFTP destination at once, with its Backup History row, one `[ERROR] [BACKUP]` line and the failure mail: "SFTP host key not confirmed: nothing was sent to this destination. In Admin, Scheduled Backups, press Test on it and confirm the key it shows." On an hourly schedule that is a failure mail and an `ERROR` line every hour. Confirming is an after-deploy step: checks 130 to 133, **at once, before anything else after the deploy**, for every SFTP destination.
- **Always check the key on the server before confirming (check 132).** Until a destination's key is confirmed, someone who holds the superadmin's session and is also on the network path between the container and the SFTP server could press Test, be shown their own key, and press Confirm: a key added where none was keeps the masked password, and Confirm saves the key and tests again at once, so the password goes to them there and then. A Test alone cannot send it: with the password masked, a Test that names a key other than the one saved, or any key where none is saved, is refused, so only a save adds a key. Each save that adds, changes or clears a key writes one `[WARN] [BACKUP]` line on the Audit page, filed under the account that saved it (card 2267), so a key confirmed that way and the real key saved back afterwards both stay on record; but the password has gone by then. That is no worse than before the deploy, when the password went to whoever answered with neither step, and it closes for each destination as soon as its key is confirmed. So confirm promptly, and compare the fingerprint shown with the server's own (`ssh-keygen -lf` on the server) **before** pressing Confirm, never after.
- **The first Test of each destination is a connection ended before authentication**, which the SFTP server logs (OpenSSH: `Connection closed by <address> port <n> [preauth]`). A fail2ban jail on sshd with `mode = aggressive` may count it: Test once, check, and Confirm, rather than pressing Test repeatedly.
- **Changing or clearing a confirmed key needs the password or private key typed again**; saved with it masked, it is refused, naming "host key".
- **Every save of a host key is one line on the Audit page** (card 2267): `[WARN] [BACKUP] SFTP host key of destination "NAS" at host:22 added: ssh-ed25519 SHA256:…` (or `changed from … to …`, `cleared: was …`, `removed with the destination: was …`), with the chip of the account that saved it; the line is a `WARN`, so it is not written with `LOG_LEVEL` at `ERROR` (the default is `INFO`). So the first confirmation of each SFTP destination after the deploy writes one such line each; a save that changes no key, or is refused, writes none. The edit form now has the private key box (**Advanced: Private Key auth**) as the add form has, so a destination that logs in with a key can be given it again.
- **Until its key is confirmed, an SFTP destination's card shows ⚠️ Host key not confirmed — press Test.** Every host key failure now says what happened in its first 40 characters, which is what Backup History shows: "SFTP host key not confirmed: …" or "SFTP host key refused: …". A server that shows the confirmed key but cannot prove it holds it (a replay of the real server's public key) is refused by name, with one `[ERROR] [BACKUP] SFTP host key signature failed for destination "…" at host:22: confirmed SHA256:…. Nothing was sent.` line.
- **A restore never takes a host key from a backup.** After an Import Backup, an SFTP destination filled from this server keeps the key confirmed here; any other comes in with none and needs Test and Confirm, and the restore's "To enter again" line says so. A database put in place by hand keeps the keys the file holds: compare each with its server before typing the password.
- **Reload any admin page left open from before the deploy.** A tab loaded before it sends no host key with a save, which would remove a key confirmed meanwhile; with the passwords masked such a save is refused, naming "host key".

#### Before the deploy

Read-only, in the container, to know what the deploy will change (no secret is printed):

```bash
docker exec <container> node -e "const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true }); console.table(db.prepare(process.argv[1]).all()); db.close();" "SELECT d.value ->> 'name' AS name, d.value ->> 'host' AS host, d.value ->> 'port' AS port, (COALESCE(d.value ->> 'password', '') <> '' OR COALESCE(d.value ->> 'privateKey', '') <> '') AS has_secret FROM settings s, json_each(s.value -> 'destinations') d WHERE s.key = 'backup_config' AND d.value ->> 'type' = 'sftp'"
```

Every row is an SFTP destination that needs checks 130 to 133 straight after the deploy, or its scheduled backups stop. No row: this card changes nothing the owner sees, and checks 130 to 137 are skipped (130 then expects no line). Have shell access to each SFTP server to hand, for check 132.

```bash
docker exec <container> node -e "const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true }); console.table(db.prepare(process.argv[1]).all()); db.close();" "SELECT value ->> 'schedule' AS schedule, value ->> 'notifyOnFailure' AS notify_on_failure, value ->> 'notifyEmail' AS notify_email FROM settings WHERE key = 'backup_config'"
```

Whether a schedule runs and whether a failure is mailed: a failure is mailed only with `notify_on_failure` true, a `notify_email` and mail set up with its password in **Admin → Email / SMTP**. With a schedule and no mail, the start-up line and Backup History are where an unconfirmed key shows.

#### After the deploy

Checks 130 to 137 run on production as the superadmin, on an SFTP destination you can log in to on its server. Run 130 to 133 for every SFTP destination the query above listed, at once; 134 to 137 on one of them. Do 135 to 137 together, one straight after another: between 135 and 137 the destination holds a key that does not match, and a scheduled run in that time fails it and mails the failure.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 130 | 2250 | **At once, before anything else after the deploy**: `docker logs <container> 2>&1` for the start | One `[WARN] [STARTUP] N SFTP backup destination(s) have no confirmed host key, and nothing is sent to them until one is confirmed: "…"` line naming each destination the query listed; no such line if it listed none | No line while the query listed one, or a destination missing from it. With `LOG_LEVEL` at `ERROR` or above the line is dropped: there, look for the destinations in Backup History or on the page instead |
| 131 | 2250 | Admin, Scheduled Backups, **🧪 Test** on the SFTP destination, once (a jail in `mode = aggressive` may count each such Test) | Before it, the card shows ⚠️ Host key not confirmed — press Test. A box under the destination: "SFTP host key not confirmed: the server at host:22 presented the host key ssh-ed25519 SHA256:…. … Nothing was sent to the server.", the key presented and ✅ Confirm this key; no toast | "Connected", or a password failure, before any key was confirmed |
| 132 | 2250 | On the SFTP server, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (the file the box names: `ssh_host_rsa_key.pub` or `ssh_host_ecdsa_key.pub` for those types) | The same `SHA256:…` as the box | Different: **stop**, do not confirm; something else answers for the host |
| 133 | 2250, 2267 | **✅ Confirm this key**, then the Audit page, System Logs | The destination saves without asking for the password, the box and the ⚠️ Host key not confirmed mark go, and the Test runs again: "Connected to host:22". One `[WARN] [BACKUP] SFTP host key of destination "…" at host:22 added: ssh-ed25519 SHA256:…` line, the same key as check 132, with your account's chip (a `WARN`: with `LOG_LEVEL` at `ERROR` it is not written; the default is `INFO`) | Asked to type the password again, or the Test fails; no line, two, or one not filed under you |
| 134 | 2250 | **▶ Run Now**, then look at Backup History | Success to the SFTP destination | Failed with "SFTP host key not confirmed: …" |
| 135 | 2250, 2267 | **✏️ Edit** the destination: change one character in the middle of the Host key's `SHA256:` part, type the password, Save, then Test | At the Save, one `[WARN] [BACKUP] SFTP host key of destination "…" at host:22 changed from ssh-ed25519 SHA256:… to ssh-ed25519 SHA256:…` line, the confirmed key first (a `WARN`, so not written with `LOG_LEVEL` at `ERROR`). At the Test, the box: "SFTP host key refused: the server at host:22 presented the host key ssh-ed25519 SHA256:…, not the confirmed SHA256:…, so nothing was sent to it. …", both keys shown, no Confirm; one `[ERROR] [BACKUP] SFTP host key mismatch for destination "…" at host:22: presented …, confirmed …. Nothing was sent.` line on the Audit page | Connected, a Confirm button, or no `ERROR` line, or two; no `changed from` line |
| 136 | 2250, 2267 | Edit it back to the key confirmed at 133, leaving the password masked, and Save | Refused, the form left open: "Backup destination "…": type its password again. A saved secret is used only with the settings it was saved with, and this changes its host key." No new `SFTP host key of destination` line | Saved with the masked password, or a line for the refused save |
| 137 | 2250, 2267 | Type the password, Save with the right key, then Test | "Connected to host:22"; one more `… changed from … to …` line, the two keys of check 135's the other way round (a `WARN`, so not written with `LOG_LEVEL` at `ERROR`) | Anything else |

No check covers a server that no longer offers a key of the confirmed type, or one that shows the confirmed key but cannot sign with it: the first would mean removing a key type from the server, the second something answering for it with a copy of its public key. Their words are in the admin guide.

#### Going back to the previous image

Nothing is done to the database. The older image connects to whatever answers again, without asking for a key, and backs up to every SFTP destination as before; it keeps `hostKey` in the setting until the backup settings are next saved, and any save made under it drops the field, since it keeps only the fields it knows. Coming forward again, a destination whose key was dropped is unconfirmed again, named by the start-up line, and needs Test and Confirm.

### Drive Connect's Refusals and Blocked Window, a Line for Each Host Key Saved, and Each Test Button Waiting for Its Own Test

**Cards 2265, 2266, 2267 and 2268.** No migration, no setting and no answer changes. On the admin page, Scheduled Backups: a Google Drive Connect that the server refuses says the server's reason (2265); the Connect box says "Opening Google's sign-in page…" until Google's address is known, says when the browser blocked the sign-in window, and always gives a link to Google's page (2266); each SFTP host key a save adds, changes, clears or removes is one `[WARN] [BACKUP]` line filed under the account that saved it (2267, which changes checks 133, 135, 136 and 137 above); and each destination's 🧪 Test button stays ⏳ until its own Test answers (2268). See [Configuring Backups](admin-guide.md#configuring-backups) and [Backups & Reporting](backup-reporting.md).

**Owner to know.**

- **The Connect box always offers a link to Google's sign-in page**, and says "Your browser blocked Google's sign-in window." when it was blocked (Safari, a strict blocker, or a server slower than about five seconds to answer). Cancel closes the box, and a window still to open for that Connect does not open.
- **Confirming an SFTP host key, and every later change of one, writes one `[WARN] [BACKUP]` line** on the Audit page under the account that saved it, not written with `LOG_LEVEL` at `ERROR` (the default is `INFO`); see the card 2250 section above.

#### After the deploy

Checks 138 to 147 run on production as the superadmin. Checks 139 to 145 need a Google Drive destination with OAuth that is **not yet connected**: add a scratch one as for checks 124 to 129, and remove it afterwards. Checks 146 and 147 need two scratch SFTP destinations whose host does not answer, such as `10.255.255.1` (any username and password), so that each Test waits for the connect timeout; remove both afterwards.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 138 | 2267 | Change only the schedule (or the retention) and **💾 Save**; then the Audit page, System Logs | No new `SFTP host key of destination` line | A line |
| 139 | 2265 | Edit the scratch Drive destination, clear the client secret, Save, then **🔗 Connect** | The toast "Client ID and Secret required"; the box closes | "Failed to generate auth URL" |
| 140 | 2265 | Type the client secret again and Save. Open Admin in a second tab; remove the scratch destination there; press Connect on it in the first tab. Then reload the first tab and add the scratch destination again, not connected | The toast "Google Drive destination not found" | "Failed to generate auth URL" |
| 141 | 2266 | Chrome devtools, Network, a custom throttling profile with 6,000 ms latency; press 🔗 Connect | "Opening Google's sign-in page…", then "Your browser blocked Google's sign-in window." with the link **Open Google's sign-in page** (the click's activation has expired by the answer) | "A Google sign-in window has opened" with no window |
| 142 | 2266 | Throttling off. Press the link; approve; paste the whole address; ✅ Connect | Connected | Refused as not started from this session |
| 143 | 2266 | Remove the scratch destination and add it again (not connected). No throttling; Connect | The window opens; the box says "A Google sign-in window has opened. If you cannot see it, open Google's sign-in page." with the link | No link |
| 144 | 2266 | Close Google's window. Throttled again: press Connect, then Cancel at once | No window opens when the answer comes, and no box | A window opens, or the box comes back |
| 145 | 2266 | Where Safari is to hand: Connect there | The blocked sentence and the link, or the window and the link; never "has opened" without a window | — |
| 146 | 2268 | Press 🧪 Test on the first unanswering SFTP destination, then at once on the second | Both buttons show ⏳ until each one's own Test answers | The first shows 🧪 as soon as the second is pressed, or when the second answers |
| 147 | 2268 | Press Test on one, then ✏️ Edit and Save it while the Test runs | The button stays ⏳ until that Test answers, then comes back; no box appears from the old Test | The button stays ⏳ for good, or comes back at once |

#### Going back to the previous image

Nothing is done to the database. The older image's Connect says "Failed to generate auth URL" for every refusal and "A Google sign-in window has opened" whether or not one did, a save of a host key writes no line, and a second Test brings back the first destination's button early. The lines already written stay in the system log.

### A Line for Every Change to the Backup Settings

**Card 2270.** No migration, no setting and no answer changes. Every save of the backup settings (Admin, Scheduled Backups) that changes anything writes one line under `BACKUP` on the Audit page, with the chip of the account that saved it: `Backup settings changed: …`, naming each setting changed with its old and new values (the failure mail address by name alone), each destination added or removed by name and type, and each destination changed by the names of its fields, never a value, a password typed again among them. A save that changes nothing, is refused or fails writes none. Card 2267's host key lines follow it, and hold the keys; this line names `hostKey` alone. See [A Save of the Backup Settings, on Record](backup-reporting.md#a-save-of-the-backup-settings-on-record).

**Owner to know.**

- **The level says what matters.** `WARN` where the save leaves fewer copies, or sends them elsewhere: a destination removed; a destination kept but pointed at another account or place (its host, port, user name or remote path; its bucket, region, prefix, endpoint or access key; its folder, client, tenant or service account); less time covered by the copies kept, the retention times the schedule's interval, which is the schedule switched to Disabled or to one more frequent (Weekly to Hourly with the retention kept covers 7 hours, not 7 weeks); or the retention lowered (the next run, a Run Now too, deletes the older copies at every destination). `INFO` for any other change, a schedule less frequent or a password typed again alone among them, so with `LOG_LEVEL` at `WARN` those are not kept, and at `ERROR` none is (the default is `INFO`).
- **A quotation mark in a destination's name is escaped** in this line and in card 2267's host key lines (`"Off\"site"`), so a name cannot make the rest of the line read as something else.

#### After the deploy

Checks 148 to 152 run on production as the superadmin, with the Audit page's System Logs filtered to `BACKUP` in a second tab. Note the schedule and retention before starting, and put them back as the checks say. Checks 150 and 151 need a scratch SFTP destination whose host does not answer, such as `10.255.255.1` (any username and password); 151 removes it.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 148 | 2270 | Raise the retention by one and **💾 Save**; then put it back and Save | One `[INFO] [BACKUP] Backup settings changed: retention from 7 to 8` line (your numbers) with your account's chip; then one `[WARN] [BACKUP] Backup settings changed: retention from 8 to 7` | No line, the first at `WARN`, the second at `INFO`, or either not filed under you |
| 149 | 2270 | Save again without changing anything | No new `Backup settings changed` line | A line |
| 150 | 2270 | Add the scratch SFTP destination and Save; then ✏️ Edit it, type a password other than the one saved, and Save; then Edit it again, change its port, type the same password again (a port changed needs it), and Save | One `[INFO]` line `destination "…" added (sftp)`; then one `[INFO]` line `destination "…" changed: password`; then one `[WARN]` line `destination "…" changed: port` (the copies would now go to another place), its details holding `"elsewhere":true`. Neither the host, the port nor either password appears in a line or its details | No line, a value in one, the second at `WARN` or the third at `INFO` |
| 151 | 2270 | 🗑️ Remove the scratch destination | One `[WARN] [BACKUP] Backup settings changed: destination "…" removed (sftp)` | `INFO`, or no line |
| 152 | 2270 | Switch the schedule to Disabled and Save; then put it back and Save | One `[WARN]` line `schedule from <yours> to disabled`; then one `[INFO]` line `schedule from disabled to <yours>` | No line, or the first at `INFO` |

#### Going back to the previous image

Nothing is done to the database. The older image writes no line for a change to the backup settings; the lines already written stay in the system log.

### A Line for Every Google Drive Connect

**Card 2273.** No migration, no setting and no answer changes. A Google Drive Connect that is saved (Admin, Scheduled Backups, 🔗 Connect) now writes one line under `BACKUP` on the Audit page, with the chip of the account that connected: `Google Drive destination "…" connected: scope narrow (drive.file); a folder made` (or `its folder reached` for a Folder ID given). It names the scope by its kind and never the token, the code, the folder's id or name. A Connect refused or not saved writes none. With cards 2267 and 2270, every change made through the backup settings or a Connect is now on record under `BACKUP` (a restore, which also rewrites them, writes its own lines, not these). The Connect's other lines under `GDRIVE` (a folder not reached, a made folder not deleted, a failure) are now filed under the account too, with the name quoted the same way. See [Backups & Reporting](backup-reporting.md#destination-types).

**Owner to know.**

- **Connecting a destination again is a `WARN`**: `… connected again, replacing the connection it had: …`. It may connect another Google account, which DumpFire cannot see, so the backups may now go elsewhere. The page offers no 🔗 Connect for a destination already connected, so this line means a Connect from a page left open since before it was connected, or one made without the page. A destination's first connection is an `INFO`, not kept with `LOG_LEVEL=WARN`.

#### After the deploy

Checks 153 and 154 run on production as the superadmin, with the Audit page's System Logs filtered to `BACKUP` in a second tab, on a scratch Google Drive destination with OAuth that is **not yet connected**, its Folder ID empty, as for checks 124 to 129. Before check 153, open Admin, Scheduled Backups in a second tab as well, and leave it unreloaded until check 154. Check 155 removes the destination; then delete the folder check 153 made in Google Drive.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 153 | 2273 | **🔗 Connect** the scratch destination | One `[INFO] [BACKUP] Google Drive destination "…" connected: scope narrow (drive.file); a folder made` line with your account's chip, its details `{"destination":"…","scope":"narrow","folder":"made","replaced":false}` | No line, `WARN`, not filed under you, or a token, code or folder id in the line or its details |
| 154 | 2273 | In the second tab, which still shows 🔗 Connect for it, Connect it again: approve and paste as before | One `[WARN] [BACKUP] Google Drive destination "…" connected again, replacing the connection it had: scope narrow (drive.file); its folder reached` | `INFO`, or no line |
| 155 | 2273 | 🗑️ Remove the scratch destination | Card 2270's `[WARN]` line `destination "…" removed (gdrive)`, and no Connect line | No line |

#### Going back to the previous image

Nothing is done to the database. The older image writes no line for a Connect saved; the lines already written stay in the system log.

### Calendar Days Read Where You Are: Goal Targets, the Dashboard and Reports

**Cards 2259, 2258, 2271 and 2275.** No migration and no setting. Production runs in UTC, so every "today" the server worked out was the UTC day.

- **Card 2259.** A goal's target date is a calendar day, read as a due date is (card 2241): the plan list, the goal's plan page and the plan PDF show the date it was set wherever the viewer is, it reads "today" on that day, and it turns late ("1d over", the "overdue" tag) only from the day after it, while work remains. West of UTC both pages read it a day early and turned it late on the target day itself. The plan list works its rows out again every 15 seconds, as the board pages do their badges, so a list left open across midnight moves on, and the goal page its "overdue" tag on the same tick.
- **Card 2258.** The dashboard counts its overdue and due-soon figures and chooses Upcoming Deadlines itself, in the viewer's own day, from the due cards its load sends, and again every 15 seconds. A report's Overdue figure counts from the day where it is made: `POST /api/reports` and `POST /api/reports/email` take an optional `timeZone`, which the Reports page sends as the browser's zone (none is UTC, as before), and a scheduled report counts from its schedule's zone. A scheduled report's PDF prints its period, generated date and completion dates in its schedule's zone, as its mail writes its period; one made by hand prints them in UTC. The PDF's Due Date column prints the day set. The dashboard's Active Tasks window moves its due words on with the same 15-second tick. See [Backups & Reporting](backup-reporting.md#pdf-generation).
- **Card 2271.** The Reports page sends "This month", "This quarter" and "Year to date" as dates, from the first day of the month, quarter or year to today, both read in the zone it sends for the Overdue figure, so each is the custom range the viewer would type and the PDF prints the days chosen. The first day was sent as the browser's midnight, a moment, which the PDF printed in UTC: east of UTC the period began the day before ("30 Sept 2026" for October from London in summer).
- **Card 2275.** "Last 7 days" to "Last 90 days" and "Last 12 months" are calendar days too: from that many days (or a year) before today to today, sent as dates in the same zone. They were moments, printed as their UTC days: from London at 00:30 BST both ends read the day before. Where the server does not know the browser's zone, the Reports page asks once more without it and says the Overdue figure is counted from the UTC day; a scheduled run counts its Overdue figure from its own moment, so one made late counts from where its period ends.

**Owner to know.**

- **Near midnight, away from UTC, the dashboard now agrees with the badges.** For an instant as the dashboard first appears it shows the UTC day's figures, then changes to the viewer's.
- **A scheduled report whose zone's day is not UTC's at its run now prints the same period as its mail**, and counts Overdue from that day: an 08:00 `Asia/Tokyo` schedule's PDF read a day before its mail. On production nothing else in a report changes, since the server's zone is UTC.
- **A script that calls `POST /api/reports` without `timeZone` gets exactly the report it got before.** One that sends a name this server does not know is refused `400` `timeZone must be a time zone name, such as Europe/London`.
- **A month, quarter or year-to-date report now covers whole UTC days**, as a custom range does, where it covered the viewer's own days from their midnight. East of UTC the first hours of the 1st by the viewer's clock (00:00 to 01:00 in UK summer time) fall in the month before; west of UTC work finished in the evening after UTC's midnight (after 20:00 in New York in summer) is in the report from the next day, not the same evening. The rolling periods ("Last 7 days" to "Last 12 months") cover whole UTC days in the same way (card 2275), where they covered N × 24 hours back from the moment.
- **A dashboard left open across the deploy can fail on its next live refresh.** The page already in the browser reads figures the new load no longer sends (`upcomingDeadlines`), and can stop drawing when the refresh brings the new data. Reload it.

#### After the deploy

Each check uses Chrome's own zone override (DevTools, More tools, Sensors, Location, a timezone), which Chrome applies to an open page without a reload; set it back to none after the checks. Checks 156 to 158 need an account that can open a goal, and a scratch goal with work left; checks 159 to 161 and 163 a scratch card assigned to yourself. Check 162 sends a scheduled report to your own address only; delete its schedule after it. Checks 165 to 167 and 170 need any board you can report on; check 168 check 156's goal; check 169 the scratch card.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 156 | 2259 | Override to `America/New_York`; give the scratch goal today's date there as its target; open `/plan`, then the goal | The target shows today's date and "today"; no "overdue" tag | Yesterday's date, "1d over", or the "overdue" tag |
| 157 | 2259 | Override to `Asia/Tokyo` after its midnight (from 15:00 UTC) with a target of the day before there | "1d over" on `/plan`, and the "overdue" tag on the goal | Not late |
| 158 | 2259 | Download the goal's plan PDF | "Target" reads the date set | Another day |
| 159 | 2258 | Between 10:00 and 24:00 UTC, give the scratch card today's UTC date as its due date. Override to `Pacific/Kiritimati` (UTC+14, already the next day) and reload the dashboard | Attention counts it overdue; Upcoming Deadlines does not list it; its board badge reads "1d overdue" | Not counted, or listed as "Today" |
| 160 | 2258 | Override to `America/Los_Angeles` in its evening (after 17:00 there), with the scratch card due on its date, and reload | Counted due soon and listed "Today", not overdue | Counted overdue |
| 161 | 2258 | On `/reports`, in check 159's zone, generate a report of the scratch card's board | The Overdue tile counts it; its Due Date reads the date set | Not counted, or another date |
| 162 | 2258 | Between 15:00 and 24:00 UTC (before 09:00 in Tokyo), make a weekly schedule of a board, zone `Asia/Tokyo`, today's weekday there, a few minutes ahead by Tokyo's clock, sent to your own address; wait for its mail | The mail's Period and the PDF's period line read the same days | The PDF a day earlier |
| 163 | 2258 | Between 10:00 UTC and 07:00 UTC the next morning (08:00 once Los Angeles is on winter time, from 1 November), when `Pacific/Kiritimati` is a day ahead of Los Angeles (outside that window the two are on one date and nothing changes): with the scratch card due today in `America/Los_Angeles` and the dashboard open under that override, switch the override to `Pacific/Kiritimati` without reloading, and wait 20 seconds | The overdue count goes up by one and the card leaves Upcoming Deadlines | Nothing changes |
| 164 | 2259 | Between 15:00 UTC and 04:00 UTC the next morning (05:00 from the night into 2 November), when `Asia/Tokyo` is a day ahead of New York (outside that window the two are on one date and nothing changes): with `/plan` open under `America/New_York` and check 156's goal reading "today", switch the override to `Asia/Tokyo` after its midnight without reloading, and wait 20 seconds | The goal reads "1d over" | It still reads "today" |
| 165 | 2271 | Override to `Asia/Tokyo`; on `/reports` choose "This month" and generate a report | The PDF's period line runs from the 1st of this month to today's date in Tokyo | It starts on the last day of the month before |
| 166 | 2271 | In the same zone, choose "This quarter", then "Year to date" | The period starts on the quarter's first day (1 January, 1 April, 1 July or 1 October), then on 1 January | It starts the day before |
| 167 | 2271 | Override to `America/Los_Angeles`, choose "This month" and use Email Report to send it to your own address | The mail's Period and the PDF's period line both run from the 1st of this month to today's date in Los Angeles | Another first or last day |
| 168 | 2259 | Between 15:00 UTC and 04:00 UTC the next morning (05:00 from the night into 2 November), when `Asia/Tokyo` is a day ahead of New York (outside that window the two are on one date and nothing changes): with check 156's goal open under `America/New_York` and no "overdue" tag, switch the override to `Asia/Tokyo` after its midnight without reloading, and wait 20 seconds | The "overdue" tag appears | No tag |
| 169 | 2258 | Between 10:00 UTC and 07:00 UTC the next morning (08:00 once Los Angeles is on winter time, from 1 November), when `Pacific/Kiritimati` is a day ahead of Los Angeles (outside that window the two are on one date and nothing changes): with the scratch card due today in `America/Los_Angeles` and reading "Today" in the dashboard's Active Tasks window (open it from the Active Tasks figure), switch the override to `Pacific/Kiritimati` without reloading, and wait 20 seconds | It reads "1d overdue" | It still reads "Today" |
| 170 | 2275 | Between 15:00 and 24:00 UTC, when `Asia/Tokyo` is a day ahead of UTC, override to `Asia/Tokyo`; on `/reports` choose "Last 7 days" and generate a report | The PDF's period line runs from seven days before today's date in Tokyo to today's date there | Both ends a day earlier |

#### Going back to the previous image

Nothing is done to the database. The older image counts the dashboard's figures and a report's Overdue from the UTC day again, prints a scheduled report's PDF in the server's zone, and ignores a `timeZone` sent to the report routes; a target date reads a day early west of UTC again; and the Reports page's periods are sent as the browser's moments again, a day out away from UTC.

### Unconfirmed Requests, and a Moved Card's Name in Other Cards' Notices

**Cards 2260 and 2261.** No migration, no setting.

- **Card 2260.** A request made on the public form without an account waits for its requester to confirm it, and until then it is not the team's. The inbox never listed one, but the person or team it was addressed to, and every administrator, could read it by its id, with the requester's address. Now `GET /api/requests/{id}`, its thread, an accept, a reject and a reply from the team answer every signed-in caller without its link `404 Request not found`, administrators included. Its own link opens it as before. See [Authentication & Security](authentication-security.md), "A thread is opened by its own token".
- **Card 2261.** Card 2256 took the names of finished work out of a card's own "Unblocked" notices when it moves to another board. Now the same move takes the card's own name out of other cards' notices too, on every card not on the board it arrives on: a notice naming it gives its number alone, and one naming one of its subtasks reads "a subtask on another board". See [Critical Path Planning](critical-path-planning.md).

**Owner to know.**

- **A signed-in account holding the link of a lapsed unconfirmed request** is now answered `404` where it was `403`.
- **An administrator cannot open an unconfirmed request either.** One can still be deleted by its id (`DELETE /api/requests/{id}`).
- **Moving a card to another board now changes comments on other cards**, not marked "(edited)". Notices naming cards moved before the deploy keep their names; `query-2256-card.sql` above lists them.

#### After the deploy

Checks 171 and 172 need the public form in a private window and mail set up; reject the request from the inbox afterwards. Checks 173 and 174 need two scratch boards you own, A and B, and a second account that is a viewer of A alone; delete both boards afterwards.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 171 | 2260 | Signed out, submit a request to yourself on the public form, and do not confirm it. Signed in as yourself (an administrator), open `/api/requests/<id>`, the id being the number in the confirmation mail's link (`/request/<id>/confirm`) | `404` `Request not found` | The request, with the address |
| 172 | 2260 | Open the confirmation link from the mail and confirm; open `/api/requests/<id>` again | `200`, the request with the address, and it is in the inbox | Still `404` |
| 173 | 2261 | On A, make card W wait on card Y; complete Y; read W's comments | `Unblocked: #<Y> "<Y's title>" completed — nothing is blocking this card now.` | No notice |
| 174 | 2261 | Move Y to B; as the viewer of A alone, open W | `Unblocked: #<Y>, a card on another board, completed — nothing is blocking this card now.`, with no "(edited)" | Y's title, or "(edited)" |

#### Going back to the previous image

Nothing is done to the database. The older image lets the team and administrators read an unconfirmed request by its id again, and leaves other cards' notices alone when a card moves; notices it finds already rewritten stay rewritten.

### The Burndown Without "All Cards Ever"

**Card 2269.** No migration, no setting and no answer changes. The burndown's daily table had an "All cards ever" column and the chart's hover an "All cards ever" row, and both only repeated Work in play: the two differ by the same number on every day, the cards finished before the period, and were identical when there were none. The column and the row are gone; the chart's explanation ("Reading the chart") now says "Finished before this period: N" once instead. The CSV keeps `all_cards` and `GET /api/v1/burndown` keeps `series[].scope`. See [Burndown Charts](burndown-charts.md#the-chart).

**Owner to know.**

- **Every burndown hover loses the row**, not only the full page's: the chart is shared, so the board's stats panel and the milestone page lose it too.

#### After the deploy

Checks 175 to 177 need any account and a board with cards finished before the last 30 days.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 175 | 2269 | `/burndown`, **Show table** | No "All cards ever" column | The column |
| 176 | 2269 | Hover the chart on `/burndown`, on a board's stats panel and on a milestone page | No "All cards ever" row in any of them | The row |
| 177 | 2269 | On `/burndown`, hover the chart's heading ("Remaining work") to open its explanation, "Reading the chart" | "Finished before this period: N", N the number of cards finished before the period's first day | "Every card that has ever existed …" |

#### Going back to the previous image

Nothing is done to the database. The older image shows the column and the hover row again.

### The Audit Range, and the Inbox and the Reply Page Saying What Failed

**Cards 2262, 2263 and 2272.** No migration and no setting. `GET /api/audit` and `GET /api/logs` answer a `from` after its `to` `400` `` `from` is after `to` ``, as `GET /api/v1/audit-log` does, where each answered `200` with an empty page; the Audit page's Audit Log tab says that, and any other failure, in a line under its filters, with no rows under it. In the inbox, a message that was not sent, an Accept or a Reject that was refused, and a list or a conversation that could not be read each say why, in the server's words, where it happened, and nothing typed is lost; a request that gets no answer no longer leaves a button on "..." or the page on "Loading...". The conversation's box, in the inbox and on the requester's reply page, stops at 5,000 characters, the server's limit. See [The Audit Page](admin-guide.md#the-audit-page) and [Task Requests](feature-overview.md#task-requests).

**Owner to know.**

- **A reversed From and To on the Audit page says "`from` is after `to`" and shows no rows**, where it showed "No audit entries match these filters.", or the rows of the search before. A script that asks `/api/audit` or `/api/logs` for a reversed range is answered `400`.
- **A message sent from the inbox after the session has ended says "Not authenticated"** under the box, and keeps the text; the page is not sent to the login page, as it is elsewhere.

#### After the deploy

Checks 178 and 179 need an administrator; 180 to 184 any account a pending request is addressed to, with a second tab open on the inbox; 185 a request's reply link from its mail.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 178 | 2262 | Audit page, **Audit Log** tab: Apply once with no dates, then From tomorrow, To yesterday, **Apply** | "`from` is after `to`" under the filters, above an empty list | "No audit entries match these filters.", or the earlier rows |
| 179 | 2262 | Put the dates right, **Apply** | The entries, and no message | The message stays |
| 180 | 2263 | Inbox: open a pending request's **Discuss**; in the other tab, **Reject** it; type a message and **Send** | "Request is already resolved" under the box; the text still in it; Send enabled | Nothing shown, or the text gone |
| 181 | 2263 | Open another request's **Discuss**; in the browser's developer tools, Network, set **Offline**; **Send** a message | "No answer from the server. The message may not have been sent."; Send enabled again, the text kept | "..." for ever |
| 182 | 2263 | Online again: paste 6,000 characters into the box | The box stops at 5,000 | It takes more |
| 183 | 2272 | Open **Accept** on a pending request and choose a board and column; in the other tab, **Reject** it; **Create Card & Accept** | "Request already resolved" above the buttons; the window open, board and column as chosen; behind it, the request has left Pending | The window open with no word, or the request still under Pending |
| 184 | 2272 | Set **Offline**; open a request's **Discuss** | "No answer from the server. The conversation was not read." where the messages would be; online again, the messages within five seconds and the line gone | "No messages yet. Start the conversation!" |
| 185 | 2272 | From the request's mail, open its reply link; set **Offline**; type a reply and **Send Reply**; online again, paste 6,000 characters | "No answer from the server. The reply may not have been sent." above the box, the text kept, **Send Reply** enabled; the box stops at 5,000 | "Sending..." for ever, or the box takes more |

#### Going back to the previous image

Nothing is done to the database. The older image answers a reversed range on `/api/audit` and `/api/logs` with an empty page again, and the inbox and the reply page say nothing when a request fails.

### Every Write Asked Again at the Write

**Card 2253.** No migration, no setting and no value changes: nothing to configure. The gate decides who is calling before a request's body is read, and a body can take up to 300 seconds to arrive. A password reset, a key deleted, a sign-out or a role lowered while a body was still arriving was met by nothing: the write went through as the caller the gate had read. Now every write route of both trees (133 handlers) asks again, inside the transaction that writes, whether its key or session is still open and who its account is now, and decides with that. See [Asked Again at the Write](authentication-security.md#asked-again-at-the-write-card-2253).

```mermaid
flowchart LR
    Gate["The gate lets the request in"] --> Body["The body arrives"]
    Body --> Ask{"At the write: key or session<br/>still open? the account now?"}
    Ask -->|"ended"| R401["401, nothing written"]
    Ask -->|"role or access lowered"| R403["403 or 404, nothing written"]
    Ask -->|"as it was"| Write["Written, as before"]
```

**Owner to know.**

- **Nothing changes for anyone whose key or session holds** and whose role is as it was. Every change on the board, the Account page and the admin page saves as before (checks 188 and 189).
- **A write whose key or session ended, or whose account's role or access changed, while its body was arriving is refused** `401` (`Invalid or expired API key` for a key, `Not authenticated` for a session) or `403`/`404` as the account now is, with nothing written, no webhook fired and no mail sent. Deleting a report schedule now asks too: a session a reset had ended could still delete one.
- **A Google Drive Connect whose session ends, or whose superadmin is made an administrator, while Google answers** is refused `401` or `403` at its save, with the folder it made removed and nothing saved, where it answered `200` with `success: false`.
- **A brief write lock where none was taken** (N7 of the plan): the report download, the report mail, the backup run, the destination Test, the Drive Connect and the test mail each take SQLite's write lock for the moment they ask, with nothing written, and so does a requester's request for a new link (`POST /api/requests/{id}/link`), which only reads. The other public request routes already took the lock when they wrote. On the one connection DumpFire has, in WAL mode, this is not noticed.
- **One `ERROR` line to report if it is ever seen**: `[ERROR] [AUTH] A write reached its handler with no credential recorded by the gate: <METHOD> <path>; refused 401; this is a fault in DumpFire, not in the request: report this line`. The gate records a credential, or none, on every request it hands on, so the line means a fault in DumpFire.
- **Whether production's proxy passes a body on as it arrives is measured, not assumed** (check 186, before the deploy). A proxy that holds a body until it is complete already closes the window before the request reaches DumpFire; the change holds either way.

#### Before the deploy

Check 186 runs on production, before the deploy. Use a throwaway account made for these checks (an ordinary user an administrator creates, kept for checks 186 to 190), never the superadmin's everyday key: sign in as it, make a scratch board (its owner can create cards on it), and make an API key for it on the Account page (Generate Key). The board's id is in its address (`/board/<id>`); its first column's id is the first `id` of `curl.exe -s -H "Authorization: Bearer <key>" https://<host>/api/v1/boards/<board id>/columns`. Save this script as `late-write.mjs` and run it with Node 18 or later, `node late-write.mjs <host> <key> <board id> <column id>`. `<host>` is the host name alone (`dumpfire.example.com`); an address with `https://` in front is accepted too. It holds the rest of the body back for 30 seconds:

```js
const [host, key, board, column] = process.argv.slice(2);
const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : 'https://' + host;
const enc = new TextEncoder();
let release;
const body = new ReadableStream({
  start(c) {
    c.enqueue(enc.encode('{"columnId":' + column + ','));
    release = () => { c.enqueue(enc.encode('"title":"late write check"}')); c.close(); };
  }
});
console.log('Delete the key in Account now. The rest of the body goes in 30 seconds.');
setTimeout(() => release(), 30000);
const res = await fetch(base + '/api/v1/boards/' + board + '/cards', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  body,
  duplex: 'half'
});
console.log(res.status, await res.text());
```

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 186 | 2253 | **Before the deploy**, signed in as the throwaway account: run the script with its key; within the 30 seconds it waits, delete that key on the Account page. If the key is still listed afterwards, delete it | `201` and one card "late write check" on the scratch board, if production's proxy passes a body on as it arrives (the window reaches DumpFire, and the old image writes); `401` if the proxy holds a body until it is complete (the window does not reach DumpFire on production). A `201` writes that one card on production; check 190 removes it with the board | Not a fault, but note it: `411 Length Required` or a `400` from the proxy, before or as the key is deleted, means the proxy refuses a body sent in chunks without a length, so this check cannot measure the window; it still exists for a body with a length on a slow link. Run 187 expecting the same refusal: the source rule and the walks in the tests are what prove the card |

#### After the deploy

Checks 187 to 190 run on production, all with the throwaway account of check 186 and its scratch board: 187 with a new key of that account; 188 with that account in one browser and an administrator in another (the scratch board is the throwaway account's own, so it can edit it; the administrator can edit any board); 189 with the same throwaway account signed in in two browsers. Never use the superadmin's real password for 189.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 187 | 2253 | As the throwaway account, make a new key; run the script again with it and delete that key within the 30 seconds. If the key is still listed afterwards, delete it | `401 {"message":"Invalid or expired API key"}`, and no new card "late write check" (or the same `411` or `400` from the proxy as check 186). On the old image, or if the change did not take, it writes one card, which check 190 removes | `201`, or the card |
| 188 | 2253 | Signed in as the throwaway account in one browser and as an administrator in another, each use the scratch board (add, move, edit and delete a card, a comment, a label) and their own Account page (emoji, notifications) | Every change saves as before | Any `401` while signed in |
| 189 | 2253 | Sign the throwaway account in in a second browser too; in the first, change its password on the Account page | Saved; still signed in in the first browser, signed out in the second at its next change | A `401` in the first browser |
| 190 | 2253 | Delete the scratch board made for check 186, and then the throwaway account | Gone, with any card check 186 or 187 wrote | — |

#### Going back to the previous image

Nothing is done to the database. The older image writes as the caller the gate read again: a write whose key or session ended, or whose role was lowered, while its body was arriving goes through, and a report schedule can be deleted by a session that has ended.

### A Reopening and a Move to Another Board Sent to Webhooks

**Card 2278.** No migration, no setting, no new event name. A card moved out of a Complete column, and a card moved to another board, wrote their activity entries and sent no webhook, so a receiver of `card.moved` missed them. Now a reopening sends its board's webhooks `card.moved` with `data.action` `card_reopened`, and a move to another board sends `card.moved` to both boards, `card_moved_away` to the one it left and `card_moved_in` to the one it joined, each with its own board's entry, which names neither board (card 2181). A move into a Complete column still sends `card.completed` instead of `card.moved`. See [Events and Payload](notifications-email.md#events-and-payload).

**Owner to know.**

- **Receivers of `card.moved` are sent more**: every reopening, and two deliveries for each move between boards (one to each board's webhooks). A receiver that took every `card.moved` for a move within one board reads `data.action`. A webhook whose `events` is an empty list is sent them too.
- **A move into another board's Complete column sends the joined board two deliveries**, `card.moved` (the arrival) and `card.completed`, where it sent `card.completed` alone.
- **A board's webhook receiver now also hears of a move to another board**, a channel wider than the board's members among them, with the route's two column titles, one of them the other board's, as the board's Activity already shows (card 2181). No board's name goes with it.

#### After the deploy

Checks 191 and 192 need two scratch boards you own, A and B, and a public request catcher (such as `https://webhook.site`) registered as a webhook on each with `POST /api/v1/boards/{boardId}/webhooks` and `{"url":"<catcher>"}` (one catcher address for both is enough: each body's `boardId` says which board it was sent for). Delete both boards afterwards; their webhooks go with them.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 191 | 2278 | On A, drag a card into Complete, then back to In Progress | Two `POST`s: `X-DumpFire-Event: card.completed`, then `card.moved` with `"action":"card_reopened"` and `"detail":"\"<title>\": Complete → In Progress"`, both with A's `boardId` | No second `POST`, or a `card.moved` for the drag into Complete |
| 192 | 2278 | From All Tasks, Move the card to B's To Do | Two `card.moved`: A's `boardId` with `"action":"card_moved_away"` and `"<title>" moved to another board (In Progress → To Do)`; B's `boardId` with `"action":"card_moved_in"` and `… moved from another board (…)`; neither body contains either board's name | No `POST`, one only, or a board's name in either |

#### Going back to the previous image

Nothing is done to the database. The older image sends nothing for a reopening or a move to another board again, but for a move into another board's Complete column, for which it still sends the joined board `card.completed`.

### The Board Page and the Card Window Apply Each Change

**Card 2280** (part B of card 2012's plan). No migration, no setting, no environment variable: nothing to configure. The board page used to re-run its whole load after every change it made and on every live event, so each change was read twice and a burst of 20 changes 20 times, and twenty of its changes said nothing when refused. Now a change shows at once and its answer is taken, or, refused, that change alone goes back and the server's words are said; other people's changes are followed by one read of the board's contents for a burst, never during a drag; and the card window saves only the fields changed in it. One read route is new, `GET /api/boards/[id]/contents`, the web application's own and not under `/api/v1/`. See [The Board Page and the Card Window](architecture.md#the-board-page-and-the-card-window) and, for what users see, [Real-Time Updates](feature-overview.md#real-time-updates) and [Cards](feature-overview.md#cards).

```mermaid
flowchart LR
    Event["A live event on the board"] --> Wait["Gathered for 250 ms,<br/>at most 1 s; held during a drag<br/>or a write of the page's own"]
    Wait --> Read["GET /api/boards/id/contents"]
    Read -->|"200"| Draw["Drawn"]
    Read -->|"401, 403, 404"| Refusal["The board's refusal page"]
    Read -->|"5xx or no answer"| Keep["Screen kept; read again on reconnect"]
```

**Owner to know.**

- **Nothing to configure.** The new route answers the board page's own session, with what the load answered, under the load's own access check (`404` `Board not found`, then `403` `You do not have access to this board`), and a `200` carries `cache-control: private, no-store`. The proxy caches nothing already ([Reverse Proxy](#reverse-proxy--nginx)), and a session's requests are not rate limited, so nothing changes there.
- **The proxy's access log changes shape.** An open board page now asks `GET /api/boards/<id>/contents` about once for each change made on the board, by anyone, where it asked `GET /board/<id>/__data.json?x-sveltekit-invalidated=…` twice for each of its own changes and once for each event.
- **A page left open across the deploy should be reloaded**, a board page or the dashboard above all. It keeps the old scripts until it is: it still works, re-reading its whole load after every change, but nothing of this card applies in it. The bar "DumpFire has been updated…" asks for the reload within about a minute ([A page left open across a deploy](architecture.md#a-page-left-open-across-a-deploy)).
- **Users will see changes take effect at once and refusals said** (a card renamed on the board, pin, priority, Move to, completion prompt, adding and deleting categories, which show once the server has taken them (a refused one keeps its name in the box), drags, board name and emoji, a column's colour, WIP limit and Add Task switch), bulk priority and archive reporting per card, an On Hold note written only once the card has moved, the card window keeping someone else's change to another field, Ctrl+Enter saving the window, Escape closing the innermost thing in it, "Todo" columns getting Add Task, and the cover's custom colour opening on the cover's colour.
- **All Tasks, All To Do and the plan page are unchanged** but for the card window's keys and cover colour: their card windows still send every field on save until card 2281 moves them onto the board's controller.

#### After the deploy

Checks 193 to 213 run on production, in two browsers, on a scratch board made for them. **A** is a throwaway ordinary account an administrator creates for these checks, with an email address the person running them owns and a password set on the admin page, so that no invite mail is sent; **B** is an administrator. In B, make a board "Check 2280" (it has To Do, On Hold, In Progress and Complete), and in its Share window share it with A as Editor: that sends a "Board shared" mail to A's address. Open it in both, with A's developer tools open on **Network**. For check 194, give the board 40 cards with an API key of A's, not B's: Editor is enough to make cards through `/api/v1/`, a wrong board id is then refused `403` rather than writing on a real board, and the key goes with A's account after check 213. Signed in as A, make the key on the Account page (Generate Key), and run in PowerShell, with the host name alone, the key and the board's id from its address (`/board/<id>`):

```powershell
$hostName = 'dumpfire.example.com'; $key = '<A key>'; $board = <board id>
$headers = @{ Authorization = "Bearer $key" }
$column = (Invoke-RestMethod -Uri "https://$hostName/api/v1/boards/$board/columns" -Headers $headers)[0].id
1..40 | ForEach-Object {
  Invoke-RestMethod -Method Post -Uri "https://$hostName/api/v1/boards/$board/cards" `
    -Headers $headers -ContentType 'application/json' `
    -Body (@{ columnId = $column; title = "Check card $_" } | ConvertTo-Json) | Out-Null
}
```

The first column is To Do. A key is allowed 60 requests a minute, so running the script twice within a minute is refused `429` partway; wait a minute and run the rest. Check 213 deletes the board; delete A's account after it, which takes its key.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 193 | 2280 | In A: rename a card on the board itself, drag it to In Progress, change its priority from its menu (right-click) | Each shows at once and stays; B shows each within about a second; A's Network shows one or two `GET /api/boards/<id>/contents` per change and no `__data.json` | A `__data.json` per change, or a card flickers back |
| 194 | 2280 | In A: select 20 cards and change their priority from the bulk bar; then select 20 and archive them | Each change shows at once; A's Network shows one or two contents reads for each bulk change, not 20; B follows | 20 reads, or a changed card flips back |
| 195 | 2280 | In A, press on a card and start dragging it, and keep holding; in B, move another card | A's drag is not interrupted; on the drop both moves show in A | A's card jumps back during the drag |
| 196 | 2280 | In B, rename the board and change its emoji in the header | A's header follows within about a second | A keeps the old name until reloaded |
| 197 | 2280 | In A, set Network to **Offline** and change a card's priority with its dot; in B, change another card's title; in A, back **Online**, then switch to another browser tab and back (a return to the tab reads the board; or keep A offline under 5 s) | A says "No answer from the server. The priority may not have been changed." and the old priority is back; once back on the tab, A shows B's new title within about a second | A keeps the new priority, or stays stale |
| 198 | 2280 | In A, set Network to **3G** (Chrome's slow preset) and make two quick changes to one card: its priority with its dot, then its title on the board | Both stay; nothing jumps back while the answers arrive. Network back to **No throttling** | The first change's read briefly undoes the second |
| 199 | 2280 | In A, drag a card into On Hold and press **Cancel**; drag it again, type a note and **Confirm** | Cancel puts the card back at once; the confirmed move keeps the note, shown on the card | A note on a card that did not move, or the card left in On Hold after Cancel |
| 200 | 2280 | In A, open card X's window, add a subtask and leave it unticked; close it and drag X into Complete; while the blocked window ("…incomplete subtask…") is open, in B move another card; then close the window | The blocked window; X back in its column at once; B's move shows in A only after the window closes | X in Complete, or the board changing under the open window |
| 201 | 2280 | In A, keyboard: edit a card's title on the board and press Enter; edit it again, type, and press Escape; rename a column and press Enter; open a column's WIP limit, and in a card's window the category chip's new category form and Save as Template | Enter saves each; Escape leaves the card's title as it was and sends nothing; the WIP limit, new category and template name boxes take the focus as they open | Escape saves, or a box without the focus |
| 202 | 2280 | In A, hover a card, and a column's header; pin a card that is new; set a column's WIP limit below its count | The drag handle shows on the card, the column's actions on its header; the New badge sits left of the pin; the column's colour bar pulses | Either not shown on hover (a scoped rule lost) |
| 203 | 2280 | In A, scroll the To Do column down and the board sideways; in B, change a card | A's scroll is kept across the refresh | A jumps to the top or the left |
| 204 | 2280 | In A, switch to the list view and pick a column; in B, change a card in it; in A, switch back to the board | The list follows B's change; the board view is as it was | The list stays stale |
| 205 | 2280 | In A, on the board, open a card in To Do and set its goal first (make a goal on the Planning page if there is none); then open its window from the board, from All Tasks, from All To Do and from that goal's plan page; on the board's, use every section: add and tick a subtask, comment, attach a small file, add a dependency, the sub-board section, a cover, Save as Template, the reporting fields | Each window opens with every section; each change saves as before | A section missing or not saving |
| 206 | 2280 | Open one card's window in A and in B; in B, change its due date and **Save**; in A, change only its title and **Save** | The card has B's due date and A's title | B's due date overwritten |
| 207 | 2280 | Open a card's window in A; in B, change that card's priority and description; then in A type in the title box, and in B rename the card; in A, **Cancel**. Open the window again in A and, typing nothing, **Save** | B's priority and description show in A's window within about a second; then the typed title stays as typed through B's rename, the caret where it was; opened again with nothing typed, **Save** closes it with nothing said | The window keeps the old values, the typed title replaced, or "Card updated" with nothing typed |
| 208 | 2280 | In A's card window: type in the description, then Ctrl+Enter; open it again, type a comment and Ctrl+Enter; open the dependency search and Escape, then Escape again; open it again, open the priority chip's dropdown and Escape | Ctrl+Enter saves once ("Card updated" once) and closes; in the comment box it posts the comment and the window stays open; the first Escape closes only the search and the second the window; Escape closes only the dropdown | Two saves, the comment box saving the window, or Escape closing the window first |
| 209 | 2280 | In B, rename the To Do column "Todo" | In A, after the refresh, the column shows Add Task, a double-click in its empty space opens New Task, and its menu shows Show Add Task ticked. Rename it back to "To Do" | No Add Task on "Todo" |
| 210 | 2280 | In A, on a saved card, More options, **Cover**: pick the first gradient, then open the custom colour box | It opens on the gradient's first colour, a blue-violet (`#667eea`), not black | Black |
| 211 | 2280 | In B's Share window, make A a Viewer; in A, rename a card on the board, add a category, rename the board, and drag a card into On Hold with a note and Confirm. Then make A an Editor again | Each is refused in the server's words (such as "No edit access to this board") and the screen goes back; the On Hold card is back in its column with no note | A change left on screen, nothing said, or a note on a card that did not move |
| 212 | 2280 | In B's Share window, remove A from the board; wait up to 30 s (the stream's heartbeat). Then share it with A again as Editor and open it again in A | A shows "You do not have access to this board"; opened again, the board | A keeps drawing the board |
| 213 | 2280 | In B, delete the board "Check 2280" | Within a few seconds A shows "Board not found". Then delete A's account | A keeps drawing the board |

#### Going back to the previous image

Nothing is done to the database. The older image re-reads the whole board after every change again, says nothing for the twenty refusals, and its card window sends every field. A page loaded from this image and left open across the change finds the contents route gone and asks for its whole load after each event, showing an empty board for a moment each time; reload it (the update bar asks within a minute).

### The Other Large Pages in Parts, and the Card Window off the Board

**Card 2281** (part C of card 2012's plan). No migration, no setting, no new route: nothing to configure. The admin page, the dashboard, All Tasks and the plan page are each split into components, drawn where their markup was, and do what they did. The card window of All Tasks, All To Do and the plan page now saves through the board page's card-window controller: **Save** sends only the fields changed in it, so a colleague's change to another field of the same card is kept; a save with nothing changed sends nothing and closes quietly; a refused or unanswered save is said and the window stays open with what was typed (the plan page said "Card updated" whatever came back). All Tasks re-reads once for a burst of live changes, not once per change. See [The Other Large Pages, in Components](architecture.md#the-other-large-pages-in-components) and, for what users see, [Cards](feature-overview.md#cards) and [Real-Time Updates](feature-overview.md#real-time-updates).

**Owner to know.**

- **Nothing to configure, and no request is new.** The card window's save is the same `PUT /api/cards/{id}`, now carrying only the fields changed and `boardId`, and a save with nothing changed sends none.
- **The proxy's access log changes shape for All Tasks.** An open All Tasks page asks `GET /all/__data.json?x-sveltekit-invalidated=…` a few times for a burst of changes on any board, about once a second while the burst lasts, where it asked once for each change: a bulk change of 20 cards was 20 full reads.
- **A page left open across the deploy should be reloaded**, All Tasks, All To Do and a plan page above all: until it is, its card window sends every field on save and All Tasks re-reads once per change. The bar "DumpFire has been updated…" asks for the reload within about a minute.
- **A plan page still re-reads its goal whenever a card window on it closes**, saved or not: the window's own writes (a subtask ticked, a dependency, an assignee) tell the plan page nothing, so it cannot tell a close after one from a close after nothing. Re-reading only after a save is a card of its own.
- **Known, and as before this card: the ✕ that takes a card out of a goal on the plan page is invisible** (card 2320). It is still there and still works, at the far right end of the card's row in the table under **The work**, where the pointer turns to a hand.
- **Nothing else a user sees changes** but what the card window saves, what it says, and All Tasks' refreshes. A section missing from the admin page, the dashboard, All Tasks or the plan page, or one that looks different from the previous image, is a fault of this card.

#### Before the deploy

Check 230 compares the plan page's burndown with production while production still runs the previous image. It runs on a local instance of this build started with `DB_PATH` set to a scratch file, beside production in a second browser, each with a goal that has a target date and some finished work.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 230 | 2281 | On the local instance and on production, open a goal's plan page; hover the burndown's **Against the target** and **Time to deliver** tips and compare their grey lines | The grey lines are the same size and colour in both | Lines larger, smaller or another colour (the burndown's copy of the rule lost) |

#### After the deploy

Checks 214 to 229 and 231 to 238 run on production, in two browsers, unless marked **local**. A local check runs against a local instance started with `DB_PATH` set to a scratch file, never production's database: an import, Vacuum, the danger zone and a password reset are not safe on live. **S** is the superadmin. **A** is a throwaway ordinary account S makes in check 214, with an email address the person running the checks owns and a password typed on the admin page, so that no invite mail is sent. After check 214, sign in as A and make A's API key on **My Account** (Generate Key). Then, as S, make a board "Check 2281" and share it with A as Editor, and give it 40 cards with the PowerShell of checks 193 to 213, run with A's key and Check 2281's id. Make a goal "Check 2281" **on that board alone**: open **Planning** from the board's header, or on the Planning page choose Check 2281 in the **New milestone** form's board select, which starts at Cross-board. A cross-board goal can be changed only by an administrator and whoever made it, so check 228 would be refused to A. Give it a target date and five of the board's cards, two of them waiting on a third. Open A's developer tools on **Network**. The last check deletes the board; delete A's account after it, which takes its key.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 214 | 2281 | As S, on the admin page, hover each section; in **User Management**, **+ Add User**: A, with an owned address and a password; change A's role to Administrator in its row, then back to User. Add a second user C with another owned address and no password, press 📧 on C's row to resend the invite, then delete C (it asks first) | Each section lifts on hover as before; A is made, saying so, and no mail goes to A's address; each role change is said and the row shows it, as does a reload; C's invite mail (the link to set a password) arrives at C's address twice, once for the add and once for 📧, or, if mail is not sent, the invite link's dialog opens with the focus on 📋 Copy and **Done** closes it; C is deleted after the confirm | A section missing or not lifting, a change not said, or the row wrong after a reload |
| 215 | 2281 | As S, **Team Management**: **+ Add Team** "Check 2281", add A to it, remove A, delete the team (it asks first) | Each is made and said, and the list follows | A step not saved or not said |
| 216 | 2281 | As S, **Application Settings**: note the App URL and save it unchanged; **Email / SMTP**: save it unchanged, then **Send Test** | The App URL shows the same after a reload; one test mail, and no other, arrives at S's own address (the signed-in account's), and the panel's line "Since the server started (…): N sent, …" counts it | A setting changed, or no test mail |
| 217 | 2281 | As S, **Scheduled Backups**: **Test** a destination; for an SFTP destination waiting on its host key (only if there is one), **Confirm this key** only after checking its fingerprint with the host's owner, and otherwise skip it; **Run Now**; if the history has more than five entries, open its **Show all** (it is offered only then), then **Run Now** again | Each test says its result; the backup is in the history, and **Show all**, where opened, stays open through the second run | A result not said, or the history shut by the run |
| 218 | 2281 | As S, **Backup & Restore**: **Export Backup**; then **Import Backup**, and **Cancel** in its dialog. The export is production's whole database, downloaded to this machine: keep it as safely as a backup, or delete it once the check is done | A `.db` file downloads; the dialog opens with its two choices ("Restore everything as it is", "Restore as a working copy") and closes on Cancel, with no file asked for and nothing imported | No file, no dialog, or anything imported |
| 219 | 2281 | **Local**, as the local instance's superadmin: import a database exported from it, in each of the dialog's two ways; **Vacuum Database**; **Purge Archived Cards**; **Reset All XP**; 🔑 on an account's row and a new password; last, **Reset Everything** | Each asks first and does what it did on the previous image; the import shows its report; the reset goes to the set-up page (a notice with **Continue to set-up** appears only if some attachment files could not be moved to the trash) | A step missing, not asked first, or not done |
| 220 | 2281 | As S, **Database Overview** and **Board Management**: make a board "Check 2281 spare" on the dashboard, then on the admin page **Clear Cats** and **Delete** on its row (each asks first) | The counts as before; the board's categories cleared, then the board deleted, and the counts follow | A step not asked first or not done |
| 221 | 2281 | Make A an Administrator; in A's browser open the admin page. Then make A a User again | A sees Database Overview, Board Management, User Management, Team Management and the Danger Zone with Purge Archived Cards, Vacuum and Reset All XP; in place of the rest, "🔒 The superadmin's", naming S; no Application Settings, Backup & Restore, Scheduled Backups, Email / SMTP or Reset Everything, and A's Network shows no read of the mail, backup or App URL settings | Any of the superadmin's sections or reads in A's browser, or no notice |
| 222 | 2281 | As S, on the dashboard: **New Board** "Check 2281 spare", **Create Board** (it opens the board), and back; star it; right-click it, **Set Category**, and file it under an existing grouping (groupings belong to everyone and outlive the board, so make no new one here); right-click it, **New Sub-board**, make one; then right-click it, **Delete Board** and Confirm | The board is made and opened; the star shows at once and stays; the board moves under the grouping; its row opens out with the sub-board in it, other groupings folded or opened as they were; the delete asks in its own words and the board goes. New Board's name box and the menu's sub-board name box take the focus as they open, and Enter in each makes it | A step not done, said wrongly, a folded grouping opening by itself, or a box without the focus |
| 223 | 2281 | As S, on the dashboard: open **Active Tasks**, **Velocity**, **Spend** and **Manage Categories** and close each; type a name in **New Board**, **Cancel**, open it again; hover a board row and look at the progress bars in the table and the sidebar | Each window opens and closes as before; the typed name is still there; the hover and the bars, colour and fill, are as on the previous image | A window not opening, the name lost, or a bar drawn wrongly |
| 224 | 2281 | In A's browser, submit a request to S from `/request`; watch S's dashboard for up to 30 s. Then, as S, reject it in the Inbox | A toast for the request, and the header's Inbox count up by one; the request is mailed to S; after the reject the count goes down at the next read (within 30 s), and the rejection is mailed to A's address | No toast, or the count unchanged |
| 225 | 2281 | In A, open All Tasks with **Network** showing; in S, on Check 2281, select 20 cards and change their priority from the bulk bar | A shows the 20 new priorities; the bulk bar sends its 20 requests one after another, and A's Network shows a few `GET /all/__data.json` for them, about one a second while the change lasts, not one per card | About one re-read per card changed, or the priorities not shown |
| 226 | 2281 | First, in S, archive two Check 2281 cards from the board. Then in A, on All Tasks: a card's **Move**, to another column of its board; **More**, **Activity Log** (it shows the move), close it, open it again; **More**, **Archived Cards**, restore one of the two Check 2281 cards, and delete the other Check 2281 card for good (it asks first); never delete a card of another board here; **More**, **Statistics**; search `#<a card's id>`, choose Check 2281 in the board filter, tick **Hide blocked**; if Complete shows **Show More** (it does only once Complete has more cards than its limit), press it; scroll the To Do bucket down and, in S, change a card | Each as on the previous image: the move made, the log kept while shut, the restore and the delete said, the filters narrowing the cards, Show More adding cards, and the scroll kept across the refresh | A panel or filter not working, or the scroll jumping |
| 227 | 2281 | In A, on All To Do: filter by board, priority and assignee, search, sort by a column; open a card from a row and close it | Each as before; the filters, sort and place kept after the window closes | A filter lost, or the window not opening |
| 228 | 2281 | In A, on the plan page of goal Check 2281: rename it by double-clicking its name (the name box takes the focus; Enter saves; a second rename left with Escape changes nothing); **Close**, then **Reopen**; change the target date (its box takes the focus); **Add cards** and add a sixth card; remove it again by clicking the far right end of its row in the table under **The work**, where the ✕ is invisible (card 2320) but the pointer turns to a hand | Each is saved and the page follows: the name, the state, the date, the card added and then gone | A change not saved, or the page not following |
| 229 | 2281 | In A, on the same plan page: look at the progress block, the burndown, the critical path and the graph; open a card from the work table, from the critical path and from the graph | Each drawn as on the previous image (the critical path's edges red in the graph); each opens the card's window | A block missing or drawn differently, or a card that does not open |
| 231 | 2281 | Open card X's window in A from All Tasks; in S, change X's due date on the board and **Save**; in A, change only its title and **Save**. Do the same from All To Do and from the plan page, each with another card | Each card ends with S's due date and A's title; A's Network shows each `PUT` carrying only `title` and `boardId` | S's due date overwritten |
| 232 | 2281 | In A, open a card's window from All Tasks, from All To Do and from the plan page, and press **Save** in each without typing | Each window closes with nothing said and no `PUT` | A `PUT`, or "Card updated" |
| 233 | 2281 | In S's Share window, make A a Viewer of Check 2281. In A, open a card from All Tasks, change its title and **Save**; then the same from All To Do and the plan page. Then make A an Editor again | Each says the server's words (such as "No edit access to this board") and stays open with the typed title; on All Tasks and All To Do the card's own title is back on the page | The window closing, "Card updated", or the typed title lost |
| 234 | 2281 | In A, set Network to **Offline**; on All Tasks open a card, change its priority and **Save**; then back **Online** | "No answer from the server. The card may not have been saved."; the window stays open with the new priority, and the card shows its old one | "Card updated", or the window closing |
| 235 | 2281 | In A, open a card's window on All Tasks and **Archive**; then the same on All To Do. Restore both from All Tasks' **Archived Cards** | Each asks first in the board page's words ("…It can be restored from Archived Cards, in the More menu."), then "Card archived. Restore it from Archived Cards." and the card leaves the page; both restored | No confirm, the card left on the page, or not archived |
| 236 | 2281 | On the plan page, open a card's window, add a subtask in the window and tick it, then close it with ✕ without saving | The plan re-reads as the window closes: the work table shows the subtask ticked | The table stale until reloaded |
| 237 | 2281 | In S, on the board page, with A's All Tasks open: archive one card, then add one | A shows each within about a second, a "created" notice for the new card | A stale until reloaded |
| 238 | 2281 | As S, delete the board "Check 2281" (and the goal, if it is left). Then delete A's account | Both gone; no grouping was made by these checks | — |

#### Going back to the previous image

Nothing is done to the database. The older image's card window on All Tasks, All To Do and the plan page sends every field on save again, the plan page says "Card updated" whatever comes back, and All Tasks re-reads once for every live change. A page loaded from this image and left open across the change keeps working; reload it (the update bar asks within a minute).

### My Stats and the Velocity Window Count Only Boards You Can Open

**Card 2292.** No migration, no setting, no new route or field. `GET /api/v1/me/stats` counted `activeCards` and averaged `avgCycleTimeDays` over the cards the key's user is assigned to on every board, and the dashboard's Velocity window (`GET /api/velocity`) counted completions the same way, so someone taken off a board saw those figures move as work went on there. Now they count only the boards the caller can open, as the dashboard's tiles and My Tasks have since card 2130. `cardsCompleted` and `streak`, the caller's own completions, are unchanged. See [What a List Gives](authentication-security.md#what-a-list-gives).

**Owner to know.**

- **A former member's figures fall once, on the deploy**: anyone still assigned to cards on a board they were taken off sees `activeCards`, the average and Velocity drop to what the boards they can open hold. An administrator opens every board, so an administrator's figures do not change.
- **`cardsCompleted` and `streak` can still drop when a board is deleted**: the activity entries go with their board, the caller's own completions among them. That is how it was before this card, not a fault of it.

#### Before the deploy

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 239 | 2292 | Immediately before the deploy, with your own (administrator's) API key, `GET /api/v1/me/stats`; write down `activeCards` and `avgCycleTimeDays` | Two figures, kept for check 243 | — |

Checks 245 to 247, in the next section, are also before the deploy: 245 makes the throwaway account T both sections use and saves the activity report's answers, and 246 and 247 read the webhooks on the host and then, as the owner decides, `PUT` (take over) or `DELETE` real webhooks on production. **Check 247 is a gate**: do not deploy until it returns no row.

#### After the deploy

Check 243 is the first step after the deploy. Then come checks 248 to 252 of the [next section](#webhooks-stop-when-their-setter-cannot-open-the-board-and-the-activity-report-reads-only-boards-you-can-open), which need T on no board and change nothing, then 240 to 242, then 244, then the next section's 253 to 258, all on production in one sitting. **O** is your own account. **T** is the release's one throwaway ordinary account, made before the deploy for check 245 of the next section, and described there; its email address is in a mailbox O controls, so sharing and assigning mail T. T is torn down once, at the end of the next section's checks. As O, make a scratch board "Check 2292" with three open cards in To Do.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 240 | 2292 | Share Check 2292 with T as Editor. As O, assign T to all three cards, then move one into Complete. Signed in as T, comment on one of its cards. With T's key, `GET /api/v1/me/stats`; signed in as T, open the dashboard and its **Velocity** window | `activeCards` **2**; `avgCycleTimeDays` a number, about 0; Velocity's total **1**; the dashboard's Active tile 2 and Completed this week 1; `cardsCompleted.total` 0 and `streak` 0 (the completion was O's); `recentActivity` holds T's comment | `activeCards` not 2, or Velocity not 1 |
| 241 | 2292 | As O, take T off Check 2292 (Share Board, remove). With T's key, `GET /api/v1/me/stats` again; signed in as T, reload the dashboard, its Velocity window and My Tasks (**Active Tasks**) | `activeCards` **0**; `avgCycleTimeDays` **null**; Velocity's total **0**; the Active tile 0 and My Tasks empty; `recentActivity` has nothing of Check 2292; `cardsCompleted` and `streak` as in check 240 | Any of the three figures still counting Check 2292 |
| 242 | 2292 | Signed in as T, compare the dashboard with `me/stats` | Active tile = `activeCards` = My Tasks' count (all 0); Velocity's total = Completed this week (both 0) | Two screens disagreeing |
| 243 | 2292 | First, right after the deploy and before check 240: with O's key, `GET /api/v1/me/stats` | The two figures of check 239 (as an administrator O opens every board), unless one of your own assigned cards was completed, archived, assigned or unassigned in between | A figure changed with none of your own assigned cards changed |
| 244 | 2292 | As O, delete the board Check 2292. T is kept, for the next section's checks 253 to 257, and torn down in its check 258 | The board gone, and T on no board again | The board left |

#### Going back to the previous image

Nothing is done to the database. The older image counts `activeCards`, `avgCycleTimeDays` and the Velocity window over every board again.

### Webhooks Stop When Their Setter Cannot Open the Board, and the Activity Report Reads Only Boards You Can Open

**Card 2326.** No migration, no setting, no new route or field. `GET /api/v1/reports/activity` read every board, or every board named in `boardIds`, and dropped afterwards the cards of boards the caller could not open, counting those boards in `meta.boardsExcludedForAccess`. The count went up whenever something happened on such a board, and the window takes times to the second, so polling it told anyone with a key when boards they could not open were worked on; naming one in `boardIds` told them whether that board had activity. Now the report reads only the boards the caller can open, the count is always `0` (still in the answer, marked deprecated), and a board named in `boardIds` is checked first, as the burndown checks one. A milestone in the report is counted over its cards on boards the caller can open, as its burndown is: a card moved onto a board they could not open was counted, and moving `from` across its completion told them when it was completed. Every other figure is as it was for the boards the caller can open. See [What a List Gives](authentication-security.md#what-a-list-gives).

**Card 2325.** No migration, no setting, no new route; one field added. Anyone who can edit a board can set up a webhook, which sends every event of the board it asks for (card titles, comment text, who did what) to an address they choose, and it kept doing so after they were taken off the board, taken out of the team the board is shared with, or the board was made private, and after an administrator who set one up was made an ordinary user. Only a password reset, an invite being used or deleting the account switched it off. Now, at each event, a webhook is sent only while the account that set it up (`webhooks.set_by`: who created it, or last set its address or secret, or switched it on) can open the board, as mail is sent only to assignees who can (card 2180). One whose setter cannot, **or that nobody is recorded as having set up**, is held: nothing is sent, nothing is written but one `WARN` an hour in the system log, and `active` stays as it was. The owner's and an administrator's answer for it carries `pausedBecause`, saying why and what to do, and `lastDelivery` says "Not sent: …". It sends again by itself when the setter can open the board again. See [Webhooks](notifications-email.md#webhooks) and [What a List Gives](authentication-security.md#what-a-list-gives).

**Owner to know.**

- **`boardIds` on `GET /api/v1/reports/activity` naming a board the caller cannot open goes from `200` to `403` `No access to board N`, and naming a board that does not exist goes to `404` `Board N not found`, administrators included**, so a saved list that holds a deleted board now fails. Each id is checked in the order given, and the first at fault is the answer.
- **`meta.boardsExcludedForAccess` is always `0`** (deprecated, still in the answer). Nothing in this repository reads it; a client outside it that does reads "no board left out", which is true.
- **A milestone's counts in the report can fall for anyone but an administrator**: its cards on boards they cannot open are left out, as the milestone's burndown already leaves them out.

- **A webhook whose setter can no longer open its board is held from the deploy on**: nothing is sent to it, `active` stays as it was, and the owner's or an administrator's answer says why in `pausedBecause`. It sends again by itself if that account is given the board back. To keep it without that, take it over: switch it off, then on with a new secret (which makes you its setter), and update the receiver with the new secret. The address was chosen by the account that lost the board, so delete the webhook unless you recognise it.
- **A webhook nobody is recorded as having set up is held from the deploy on.** Setters have only been recorded since 2026-10-18/19 (migration 0056), so that is almost every webhook made before then. Query B (check 247) is the gate: every such webhook is taken over or deleted before the deploy, so that no integration anyone knows about stops. A restore of an older backup brings them back, held: run Query B again after any such restore.
- **No screen shows a held webhook.** `pausedBecause` is in the API alone, and the `WARN` in the system log, which administrators read. A board's owner learns of a held webhook by reading the board's webhooks with their key. An on-screen view is card 2329.

#### Before the deploy

**O** is your own administrator account and API key. **T** is the release's one throwaway ordinary account, used by card 2292's checks too: O makes it on the admin page **before the deploy** (check 245 needs its key then), with a password typed there, so that no invite mail is sent, and an email address in a mailbox O controls. T signs in from a separate browser profile or a private window, so that O's own session is kept, and makes its own API key on **My Account** (Generate Key). T is on no board. While T exists it is listed to everyone signed in (the user pickers, `GET /api/users`) and on the public request form, so it is torn down once, at the very end of the release's checks.

Checks 245 and 248 ask for a fixed, closed window in the past, `?from=2026-09-01&to=2026-09-30`, so that work done in between cannot move a figure.

Card 2325's checks after the deploy also use **S2**, a fresh private board O makes for them, holding only cards titled `2325-check-…`, and **the receiver, `<CATCHER>`**: an HTTPS address O chooses and controls, such as a request-catcher service O picks or a path on a server of O's, reachable from production and not inside the network (production refuses inside addresses). Never a third-party address chosen for you. Two paths are used, `<CATCHER>/o2325` and `<CATCHER>/t2325`. Every write is to S2, T or the two test webhooks; no real board's cards, members or webhooks are touched.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 245 | 2326 | Make T and T's key. **Immediately before the deploy**, with T's key `GET /api/v1/reports/activity?from=2026-09-01&to=2026-09-30`; with O's key the same. Save each whole answer to a file (`t-245.json`, `o-245.json`) | T's `meta.boardsExcludedForAccess` probably above 0 (the fault being fixed); O's `0` | — (a record, kept for check 248) |
| 246 | 2325 | Query A, below. Take over each row you recognise now (off, then on with a new secret, the receiver updated); then run Query A again and write down the ids it still lists | The second table holds only the rows not taken over; they are held from the deploy on | A row taken over still listed (the takeover did not make you its setter) |
| 247 | 2325 | Query B, below, **the gate**: every row taken over or deleted, then Query B run again | No row | Any row left: **do not deploy** |

**Query A: active webhooks whose setter cannot open the board today** (check 246). These are held from the deploy on, which is the fix. The output gives the board's name, its owner, the setter's username and the address's host only, never its path, which can carry a token. A `set_by` that names no account (possible after a restore) shows `setter` empty, and is listed too.

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT w.id, b.name AS board, o.username AS board_owner, w.set_by, u.username AS setter, w.url FROM webhooks w JOIN boards b ON b.id = w.board_id LEFT JOIN users o ON o.id = b.created_by LEFT JOIN users u ON u.id = w.set_by WHERE w.active = 1 AND w.set_by IS NOT NULL AND (u.id IS NULL OR (u.role NOT IN (@admin, @superadmin) AND (b.created_by IS NULL OR b.created_by <> u.id) AND b.is_public = 0 AND NOT EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = w.board_id AND m.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM board_teams bt JOIN team_members tm ON tm.team_id = bt.team_id WHERE bt.board_id = w.board_id AND tm.user_id = u.id))) ORDER BY w.id').all({ admin: 'admin', superadmin: 'superadmin' });
console.table(rows.map(({ url, ...r }) => { let host; try { host = new URL(url).host; } catch { host = '(not a URL)'; } return { ...r, host }; }));
db.close();
"
```

An empty table is the hope. Each row stops sending at the deploy. **One you recognise can be taken over before the deploy, so that its integration never stops**: the board's owner or an administrator sends `PUT /api/v1/webhooks/{id}` `{"active": false}`, then `{"active": true, "secret": "<new>"}`, and updates the receiver with the new secret. That makes them its setter, so it is not held. One nobody recognises is left to be held, or deleted. Whoever takes it over answers for it: a reset of their account, or deleting it, switches it off. Prefer the board's owner where they have a key. A single `PUT {"secret": "<new>"}` also takes it over, with no gap while it is off. Off then on, with no secret change, takes over a receiver that does not check signatures.

**Query B: active webhooks with no setter. A GATE** (check 247). Do not deploy until it returns no row. It gives the address in full, which you need in order to recognise it, so do not paste the output anywhere: a path can carry a token.

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
console.table(db.prepare('SELECT w.id, w.url, b.name AS board, o.username AS board_owner FROM webhooks w JOIN boards b ON b.id = w.board_id LEFT JOIN users o ON o.id = b.created_by WHERE w.active = 1 AND w.set_by IS NULL ORDER BY w.id').all());
db.close();
"
```

For every row, the board's owner or an administrator either takes it over (the same off, then on with a new secret, and the receiver updated) or deletes it (`DELETE /api/v1/webhooks/{id}`). Whoever takes it over answers for it: a reset of their account, or deleting it, switches it off. Prefer the board's owner where they have a key. A single `PUT {"secret": "<new>"}` also takes it over, with no gap while it is off. Off then on, with no secret change, takes over a receiver that does not check signatures. Then run Query B again: it must return no row. It is run once more after the deploy (check 251) and must still return no active row. Restoring a backup older than 2026-10-18/19 brings setter-less webhooks back, so after any such restore run Query B again and deal with each row the same way.

#### After the deploy

Checks 248 to 252 run straight after check 243 of card 2292's section, before its check 240. They are GETs and a read-only query, and change nothing; 251 and 252 come this early so that a real webhook held at the deploy is seen at once. Then card 2292's checks 240 to 242 and 244 run, which leave T on no board again, and then checks 253 to 257 below, with T. Check 258 tears down everything the release's checks made, T included, once, at the very end.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 248 | 2326 | The two GETs of check 245 again, the same window, each whole answer saved (`t-248.json`, `o-248.json`). Compare each with its file from check 245, with `meta.generatedAt` taken out of both | O's two identical. T's identical but for `meta.boardsExcludedForAccess`, now `0`, and the counts of a milestone with a card on a board T cannot open, which are now left out (the second fix), so a milestone may also drop from T's list. Either may differ if a card of that window was edited, completed or deleted in between, or a card joined or left a listed milestone | T's count is not 0, or anything else differs with no such change |
| 249 | 2326 | With T's key, `GET /api/v1/reports/activity?boardIds=<any private board T is not on>`; then `?boardIds=999999` | `403` `{"message":"No access to board <id>"}`; then `404` `{"message":"Board 999999 not found"}` | `200` to either |
| 250 | 2326 | With O's key, `GET /api/v1/reports/activity?boardIds=999999` | `404` `{"message":"Board 999999 not found"}` (the change for administrators) | `200` |
| 251 | 2325 | Query B again (before the deploy, above) | No active row | Any row (a webhook made or restored since check 247) |
| 252 | 2325 | Run Query A again; with O's key (an administrator's), `GET /api/v1/webhooks/<id>` for each row it lists | Each `active: true`, `pausedBecause` "The account that set this up can no longer open this board, so nothing is sent. …" | Any row with `pausedBecause` `null` (it is still sending) |

Card 2292's checks 240 to 242 and 244 come here. Then, with T on no board:

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 253 | 2325 | As O, make S2 and share it with T as Editor. With T's key `POST /api/v1/boards/<S2>/webhooks` `{"url": "<CATCHER>/t2325"}`; with O's key the same with `<CATCHER>/o2325`. As O, raise a card `2325-check-1` on S2 | The receiver gets two `POST`s with `X-DumpFire-Event: card.created`, one on each path, each body's `data.detail` naming the card. The create's answers carry `pausedBecause: null` | Either missing (the check holds a setter who can open the board) |
| 254 | 2325 | As O, take T off S2 (Share Board, remove). Raise `2325-check-2`. With O's key `GET /api/v1/boards/<S2>/webhooks`. With T's key, the same | The receiver gets only `/o2325`. O's answer: T's webhook `active: true`, `pausedBecause` "The account that set this up can no longer open this board, so nothing is sent. …", `lastDelivery.outcome` `not-sent`; O's own `pausedBecause: null`. T's GET `403` | Anything arrives on `/t2325`, or `pausedBecause` is missing or `null` on T's |
| 255 | 2325 | As an administrator, open the system log (Admin) and look under `Webhooks` | One `WARN` `Webhook <id> on board <S2> not sent: the account that set it up (user <T>) can no longer open the board`, with no address in it; raising `2325-check-3` adds no second line | No line, a line per event, or an address in it |
| 256 | 2325 | As O, share S2 with T again as **Viewer**. Raise `2325-check-4` | Both paths receive it; T's webhook's `pausedBecause` `null` in O's answer | `/t2325` still silent |
| 257 | 2325 | As O, take T off S2 again. With O's key `PUT /api/v1/webhooks/<T's>` `{"active": false}`: the answer has `pausedBecause: null` (it is off). Then `{"active": true, "secret": "check-2325"}`. Raise `2325-check-5`. Save `/t2325`'s raw body, byte for byte as the receiver got it, to `body.json`, and run `node -e "console.log('sha256='+require('crypto').createHmac('sha256','check-2325').update(require('fs').readFileSync('body.json')).digest('hex'))"` | Both paths receive it (O is now the setter); the line printed equals `/t2325`'s `X-DumpFire-Signature` (in checks 253 to 256 that header was empty: neither webhook had a secret); `pausedBecause` `null` | `/t2325` silent, the second `PUT` refused, or the signature not the one printed |
| 258 | both | **Tear down**, once, at the very end of the release's checks: with O's key `DELETE /api/v1/webhooks/<each of the two>`; as O delete S2; signed in as T, revoke T's key (My Account); as O, delete T (Admin, User Management). Clear or delete the receiver's two paths. Delete the saved answers of checks 245 and 248: they hold card titles | No webhook on S2 (gone with it); T no longer in the user pickers or on the request form | Anything left |

#### Going back to the previous image

Nothing is done to the database. The older image reads every board for the activity report again, counts the boards left out in `meta.boardsExcludedForAccess`, counts a milestone's cards on every board, and answers a named board the caller cannot open, or one that does not exist, `200`.

The older image also sends to every active webhook, held ones included (a setter who lost the board, or none recorded), and answers no `pausedBecause`. So **before going back, switch off or delete any held webhook that must not send**: check 252's ids, and any webhook Query B or Query A lists then.

### The Work Table's Remove Button, the Picker's Late Search and the Request Toasts' Poll

**Cards 2320, 2328 and 2312.** No migration, no setting, no route; the page code only. The plan page's ✕ that takes a card out of a goal was always invisible (its reveal rule was left on the lists it moved out of in September); it now shows on the row under the pointer or holding the keyboard's focus, and always on a touch screen. The plan page's card picker no longer sends a search started just before the page was left. The dashboard's request toasts no longer leave a 30-second poll running when the dashboard is left before the inbox's first answer, start the poll even when that first read fails, and clear their toasts' timers when the page goes.

**Owner to know.** On a phone or tablet the ✕ is now always shown in the work table's last column. After a failed first read, the first poll takes the count without raising a toast for each request already waiting.

#### After the deploy

On production, as any account that can change a goal, on a goal with at least one card; a browser with its developer tools' network panel.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 259 | 2320 | Open the goal's plan page. Move the pointer over a card row of **The work** | A ✕ appears at the right end of that row only, and goes when the pointer leaves | No ✕ on hover |
| 260 | 2320 | On the same page, press Tab until the focus reaches a row's ✕ | The ✕ shown with its focus ring; Tab on to the next row, and that row's ✕ shows | A focus ring around nothing |
| 261 | 2320 | Open the plan page on a phone or tablet | The ✕ shown on every card row, without a tap | No ✕ until tapped |
| 262 | 2328 | In the network panel tick **Preserve log** and filter on `cards/search`. On the plan page, open **+ Add cards**, type one letter and press **Alt+←** straight away | No `cards/search` request at all | Any `cards/search` request |
| 263 | 2312 | Throttle the network panel to **Slow 3G**, open the dashboard and leave it by a sidebar link before `/api/requests` answers, to any page but **Inbox** (which reads `/api/requests` itself). Stop throttling and wait 70 s on that page | No further `GET /api/requests` | A `requests` call every 30 s |
| 264 | 2312 | With a request waiting in the inbox, block the address `/api/requests` in the network panel, open the dashboard, unblock it, and wait 35 s | One `GET /api/requests` at about 30 s; the header shows the count; **no** "New Request" toast for the request already waiting | No poll, or a toast for the old request |

#### Going back to the previous image

Nothing is done to the database. The older image hides the work table's ✕ again (still clickable), sends a picker search started just before the page is left, and on the dashboard can leave a poll running for the life of the tab, never starts it after a failed first read, and after a refused one (an error answer) toasts every waiting request on the first poll.

### Comments: Same-Second Order, One Emoji Shape, Unchanged Edits, Live Updates and Recorded Deletes

**Cards 2301 and 2302.** No migration, no setting, no new route or field. A comment's `created_at` is kept to the second, and a card's comment list (the card window, `GET /api/cards/:id/comments` and `GET /api/v1/cards/:cardId/comments`) was ordered by it alone, so comments made in the same second came back in no set order, in practice the earliest first inside a list that is newest first. Accepting a task request copies its whole discussion onto the new card in one loop, so those copies always read upside down. Now a tie is broken by id, the later first, as the activity report already breaks it, and the discussion is copied in the order it was sent (by id within one second). The same list answered `userEmoji` `null` for an author with no emoji, where every other comment answer, and the `Comment` schema, have `"👤"`; it now answers `"👤"` too. Only an account restored from an old backup, or changed directly in the database, has no emoji; no stored data changes.

**Card 2284.** No migration, no setting, no new route or field. Save pressed on a comment whose text was not changed (in the card window, or `PUT` through either API with the text it holds) wrote the comment again with a new `updatedAt`, so the window showed "(edited)" on it, recorded "Edited comment" in the board's Activity Log and the audit log, and marked the card as worked on by whoever pressed Save in the activity report. Now text that is the comment's own once both are trimmed writes nothing, records nothing and tells no open page, and is answered with the comment as it is; the card window sends nothing for it and closes the box, and after a real edit takes the comment's time from the server's answer rather than its own clock. A caller who may not edit the comment is refused as before, whatever text it sends.

**Card 2282.** No migration, no setting, no new route or field. A comment added, on a page or through the API, told no open page, so anyone with the card window open saw it only after closing and reopening the card. Now a comment added or edited, and an "Unblocked" notice (which is a comment), sends the card's board the live update `{type: 'comment', cardId}` (an edit sent `{type: 'card'}`). Every open page re-reads on it as on any update, and a card window open on that card, on the board page, All Tasks or All To Do, reads its comments again about a quarter of a second later: the new comment appears at the top and the tab's count rises. The re-read is quiet: "Loading comments..." never replaces the thread, and a comment being edited keeps its box, text, focus and caret; if someone else deleted that comment it stays, marked "(deleted)", until Save (which says "This comment no longer exists." and keeps the text) or Cancel. The window reads them again after a reconnect and on a return to the tab too, which may have missed one. The plan page's window, which has no live stream, does not.

**Card 2283.** No migration, no setting, no new field; **one new API operation**, `DELETE /api/v1/comments/{commentId}`, which answered `405`. Deleting a comment, in the card window or through the API, recorded nothing and told no open page: the Audit page, a board's Activity Log, `GET /api/v1/audit-log` and the activity report had no trace of it, an administrator removing someone else's words included, and another open window went on showing it. Now a delete writes a `comment_deleted` entry, "Deleted comment", `Deleted a comment on "<card>"`, or `Deleted a comment by <author> on "<card>"` when the deleter is not the author, never with the comment's text, and sends the same live update as an add or an edit, so a card window open on the card loses it. Who may delete is unchanged: the author while they can edit the board, or an administrator; a board's owner may not delete someone else's. The new API operation lets the same people delete through a key, in the card window's words (`403 You can only delete your own comments`, `403 No edit access to this board`, `404 Comment not found`). No webhook is sent for a delete; `comment.added` is still the only comment event. The OpenAPI document stays `1.2.0`, with item 85 in its 2026-10-14 note.

**Owner to know.** Nothing a person sees changes but the order of comments made in the same second, chiefly a request's discussion on the card it was accepted into, which now reads newest first like the rest, and an unchanged Save no longer marks a comment "(edited)" or adds an "Edited comment" entry; **an open card window now shows other people's comments as they are posted, edited or deleted**, on the board page, All Tasks and All To Do; and **a comment deleted now shows in the Activity Log and the Audit page as "Deleted comment"**, naming the author when an administrator deleted someone else's. Each comment, edit or delete costs every open page one re-read, as an edit already did. API keys can now delete comments, the same ones their account could delete on screen. Deleting a comment does not call back the mail already sent with its preview when it was posted (to the board's members, anyone it mentioned and the card's requester). The card window already drew `"👤"` for an author with no emoji.

#### After the deploy

On production, with your own API key, on a **scratch board** of your own with no other members and **no webhooks**, and a scratch card made on it by hand, not from a request: a comment mails the board's members and the card's requester and fires `comment.added`. Every comment is posted to the scratch card. The board and card are kept for the later checks of this group; delete them at the end of the release's checks. For checks 268 and 275, an administrator's API key (`GET /api/v1/audit-log` is administrators' only), or read the board's Activity Log instead. For check 276, a second account that is **not** an administrator: only just before 276, share the scratch board with it as an **editor** and make it an API key; straight after 276, take it off the board and revoke that key. That account is sent the "board shared" mail when it is added, and the comment mail for any comment posted while it is a member. Every comment deleted is one made for the check. For checks 269 to 274, two browser windows, **A** and **B**, signed in (the same account will do), and the scratch card in the board's **To Do** column, so that All To Do lists it.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 265 | 2301 | With your key, `POST /api/v1/cards/<card>/comments` five times in one PowerShell loop (`{"content": "c1"}` to `"c5"`), then `GET /api/v1/cards/<card>/comments`. If no two share a `createdAt`, run the loop again | At least two share a `createdAt`; among those, the higher `id` is listed first, and the whole list is newest first | Two with one `createdAt` listed lower `id` first |
| 266 | 2302 | `GET /api/v1/cards/<card>/comments` | Every `userEmoji` is text | Any `null` |
| 267 | 2284 | Open the scratch card in the board page, its **Comments** tab. **Edit** one of your comments that shows no "(edited)", and press **Save** without changing it. Then open the board's **Activity Log** | The box closes; no "(edited)" on the comment; no new "Edited comment" entry | "(edited)" appears, or a new entry |
| 268 | 2284 | With your key, `GET /api/v1/comments/<id>` for one of your comments on the card and note `updatedAt`; then `PUT /api/v1/comments/<id>` with `{"content": "<its exact text>"}`. Then, with an administrator's key, `GET /api/v1/audit-log?cardId=<card>&action=comment_edited` (or open the board's Activity Log) | `200`, the same `content` and the same `updatedAt` as before; no new entry | A new `updatedAt`, or a new entry |
| 269 | 2282 | On the **board page**, open the scratch card in both windows on the **Comments** tab. Post a comment in A | B shows it within about two seconds, at the top, and the tab's count rises, without reopening | B unchanged until reopened |
| 270 | 2282 | Edit that comment in A and save it with new text | B shows the new text and "(edited)" | B shows the old text |
| 271 | 2283 | **Delete** that comment in A. Then open the board's **Activity Log** | B's list loses it within about two seconds and the tab's count falls; the log has "Deleted comment", `Deleted a comment on "<card>"`, without the comment's text | B still shows it, or no entry, or the entry holds the text |
| 272 | 2282, 2283 | Repeat 269 to 271 with both windows on **All Tasks**, then on **All To Do**, opening the card from each | The same as 269 to 271 on each page | Any page where B does not follow |
| 273 | 2282 | On the board page, in B open **Edit** on one of your comments, type a few words, scroll the thread a little, and leave the caret mid-text. Post a comment in A | B's new comment appears; B's edit box keeps its text, focus, caret and scroll; "Loading comments..." never shows | The edit box closes, loses text or focus, or the thread jumps |
| 274 | 2282 | In B switch to another browser tab. Post a comment in A. Return to B's tab | B shows the comment within about two seconds of returning | B shows it only after reopening |
| 275 | 2283 | With your key, `POST /api/v1/cards/<card>/comments` `{"content": "To delete"}` and note its `id`; `DELETE /api/v1/comments/<id>`; then `GET /api/v1/comments/<id>`. Then, with an administrator's key, `GET /api/v1/audit-log?cardId=<card>&action=comment_deleted` (or open the board's Activity Log) | `200` `{"success": true}`; the `GET` is `404` `Comment not found`; the log has an entry with `action` `comment_deleted` and `source` `api` (`rawAction` `api:comment_deleted`), `Deleted a comment on "<card>"` | `405`, or the comment still there, or no entry |
| 276 | 2283 | Share the scratch board with the second account as an editor and make it a key (see above). With your key, post another comment and note its `id`. With the second editor's key, `DELETE /api/v1/comments/<id>`; then, with yours, `GET /api/v1/comments/<id>`, and delete it with your key to tidy up. Then take the second account off the board and revoke its key | The editor's `DELETE` is `403` `You can only delete your own comments`; the comment is still there until you delete it | `200`, or the comment gone |
| 277 | 2283 | `GET /api/v1/openapi.json` | `info.version` is `1.2.0`; `paths["/api/v1/comments/{commentId}"].delete` is present; the description holds items 82 to 85 | A version change, or no `delete` |

Check 274 proves that the window follows a comment posted while its tab was hidden. It does not prove the return-to-the-tab re-read by itself: a hidden tab's stream usually stays open, so B is most often told by the comment's own event, and the re-read on return only shows when the browser closed the stream while the tab was hidden (some do after a few minutes, or a laptop asleep). The return-to-the-tab and reconnect paths are held by the suite (`tests/card-window-comments.svelte.test.ts`, `tests/all-tasks-page.test.ts`, `tests/page-failures.test.ts`).

#### Going back to the previous image

Nothing is done to the database. The older image lists comments of one second in no set order (in practice the earliest first), copies a request's discussion in no set order within one second, answers `userEmoji` `null` in the list for an author with no emoji, writes, records and announces a comment saved unchanged, which the window shows as "(edited)", sends no live update for a new comment and `{type: 'card'}` for an edit, and leaves an open card window showing the comments it read as it opened. It records nothing for a deleted comment and tells no open page, and answers `405` to `DELETE /api/v1/comments/{commentId}`: an agent or script that deletes comments through the API stops working, and should be told before going back. `comment_deleted` entries already written stay, and the older image's Activity Log and Audit page read them as "Comment deleted" (the words made from the name, as for any action it has no label for).

### The Activity Log: Re-Archiving, Position Changes, Goal Changes, Bulk Dependencies and Subtask Edits

**Card 2285.** No migration, no setting, no new route or field. Archiving a card that was already archived (a `DELETE` sent again through the API after a timeout, a script run twice, or a stale tab in the web application) stamped it again: `archivedAt` and `updatedAt` were set to the time of the second request, so the time the card was really archived was lost and the Archived page sorted it by the later one; a second "Archived card" entry was written in the board's Activity Log, the Audit page and `GET /api/v1/audit-log`; the activity report counted the card as touched again; and every open page of the board was told. Now an archive of a card already archived is answered as before, `200` `{"success": true}`, so a retry does not fail, but writes nothing, records nothing and tells no open page, in both trees. It is the other half of the rule the restore already has for a card that is not archived. No webhook was or is sent for an archive. The OpenAPI document stays `1.2.0`, with item 86 in its 2026-10-14 note.

**Card 2299.** No migration, no setting, no new route or field. Unticking a subtask, and changing its title, description, priority, colour or due date, recorded nothing, on a page or through the API: only a tick was in the board's Activity Log, the Audit page and `GET /api/v1/audit-log`. And every save wrote the subtask and told the board's open pages, even one that changed nothing, which the subtask window sends on every Save. Now an untick writes "Updated subtask", `Reopened <subtask> (on <card>)`, and mails nobody; any other change but the subtask's place in the list writes "Updated subtask", `Updated <subtask> (on <card>): title, dueDate`, naming only the fields changed; a request that ticks or unticks and edits writes one entry for each. A save that changes nothing writes nothing, records nothing and tells no open page. A change of position alone is written and told, and not recorded, as before. No webhook was or is sent for any subtask entry. The OpenAPI document stays `1.2.0`, with item 87 in its 2026-10-14 note.

**Card 2291.** No migration, no setting, no new route or field. `POST /api/v1/dependencies/bulk`, which the tracking workflow's `add-dependencies` and `add-chain` use, wrote one "Added dependencies" entry for a whole batch, `Recorded N dependencies across M board(s)`, with no card, on the first board it touched alone: a card's history in All Tasks never showed the links a batch made, and the other boards' Activity Logs said nothing. Now each link it creates writes one "Added dependency" entry, as adding one link in the card window or through `POST /api/v1/cards/{id}/dependencies` does: on the board of the card that waits (a subtask's card), naming that card, `#12 now waits on subtask #45`. A link skipped as already recorded writes none, and a batch that writes nothing tells no open page, as before. No webhook was or is sent for either. The OpenAPI document stays `1.2.0`, with item 88 in its 2026-10-14 note.

**Card 2288.** No migration, no setting, no new route or field. A change of a card's position within its column is not an edit to the card, and a drag and `PUT /api/v1/cards/{id}/move` have never recorded one. The web application's card update, `PUT /api/cards/{id}` with a `position` and no change of column, did: it moved the card's `updatedAt`, wrote "Updated card" `Updated fields: position on "<card>"` and sent the board's webhooks `card.updated`. Now it goes through the drag's path: the position alone is written, nothing is recorded, no webhook is sent, and the open pages get the drag's update. Sent with other fields, the entry and the `card.updated` name those alone. A position the card already holds, sent back, changes nothing. No page sends a position on that route, and it takes no API key, so only a request made by hand from a signed-in browser reached it. The OpenAPI document stays `1.2.0`, with item 89 in its 2026-10-14 note.

**Card 2289.** No migration, no setting, no new route or field. Only creating a goal on a board was recorded. Renaming a goal, changing its description, target date or board, closing, reopening and deleting it recorded nothing, on the plan page or through the API, and a delete, which releases every card in the goal, told no open board, so the 🎯 chip of a goal that was gone stayed on every open board until a reload. Putting a card in a goal or taking it out recorded nothing either, from the card window's picker, the plan page's Add cards, the API's single routes or its bulk routes, except through `PUT /api/v1/cards/{id}` with `milestoneId`, which wrote "Updated card" `Updated fields: milestoneId` and sent `card.updated`. Now six new entries are written: "Updated milestone" (`Updated milestone "Launch": name, targetDate`, the fields named, not their values), "Closed milestone", "Reopened milestone" and "Deleted milestone" (`Deleted milestone "Launch"; 2 cards on this board released`), with no card, on the goal's board, or for a goal across boards on each board holding its cards (on a change of board, the boards before and after); and "Added card to milestone" (`Added "T1" to milestone "Launch"`, with `(from milestone "Pilot")` when the card left another goal) and "Removed card from milestone" on the card's board, from every route that puts a card in or takes it out, the bulk ones one entry per card. On each board a goal is named as that board's readers knew it before the change, by its new name only on a board it joins, and a goal across boards as `milestone #<id>`, since a reader of one of its boards may not be able to open it. The card update's `milestoneId` writes the goal entry in place of naming `milestoneId`. A change that changes nothing, a goal saved with every field as it is or a card put in the goal it is already in, writes, records and tells nothing, and a request that would be refused still is. A goal changed or deleted tells its boards' open pages, and a delete every board a released card is on, so the chip goes at once. No webhook is sent for any goal entry, and there is no goal event (card 2343 raises a `milestone.*` webhook event). The plan-created mail is still sent by the API's bulk attach alone. The OpenAPI document stays `1.2.0`, with item 90 in its 2026-10-14 note, and the webhook `events` descriptions say that goal membership sends no `card.updated` on any route.

**Owner to know.** Nothing a person sees changes but the second "Archived card" entry, which is no longer written, and a card's archive time, which now stays the first one (2285). **Subtask edits now show in the Activity Log and the Audit page as "Updated subtask"**, and **they count as work on the card in the activity report**, as a tick already did: a card whose only activity in the report's window is an edit to one of its subtasks is now in the window, put down to whoever made the edit, so the count of cards worked on can rise from the deploy on (2299). **"Added dependencies" is no longer written**: an Audit page or `GET /api/v1/audit-log` filter on `dependencies_bulk_added` finds older entries only from the deploy on, and one on `dependency_added` now finds the links of a batch too. A plan laid down in bulk now writes one entry per link, and a board's Activity Log shows its last 50 entries only, so a large batch can push older entries off it; the Audit page keeps them all (2291). **`card.updated` is no longer sent for a position-only change on the web application's card update** (`PUT /api/cards/{id}`), which a drag and the API's move never sent; with other fields it is still sent, its `detail` no longer naming `position`. A webhook receiver could in principle have relied on it, though no page sends that request (2288). **`card.updated` is no longer sent when `milestoneId` is the only change on `PUT /api/v1/cards/{id}`**: goal membership sends no `card.updated` on any route, and a receiver reads `GET /api/v1/milestones/{id}` or the audit log; the tracking workflow puts cards in goals through the goal routes, not this field (2289). **The plan-created mail stays with the API's bulk attach**: putting cards in a goal one at a time, on the plan page or in the card window, mails nobody, so a goal filled a card at a time sends no "Plan created" (2289). **Whoever puts a card in a goal is no longer credited with work on it in the activity report**: the goal entries are planning, as a link is. The card's `updatedAt` still moves when it goes in or out, so the card can still enter the report's window; only the credit to the person changes (2289). **A plan laid down in bulk writes one entry per card** (and one per link), and a board's Activity Log shows its last 50 entries only, so a large batch can push other entries off it; the Audit page and `GET /api/v1/audit-log` keep them all. **A card moved from one goal to another writes one "Added card to milestone" naming the goal it left, and no "Removed card from milestone" for that goal.** **A card deleted for good, a board deleted (which takes cards elsewhere out of its goals), a card moved to another board (whose move entry already ends "and out of milestone …") and an import write no goal entries** (2289).

#### After the deploy

On production, with your own API key. **The scratch board:** one of your own, no other members, **no webhooks**, with three scratch cards T1, T2 and T3 made by hand in To Do (not from a request, and with no assignee: an assignment and a requester mean mail). Every write is to the scratch board; keep the board and its cards for the later checks of this group and delete them at the end of the release's checks. For the audit log, an administrator's API key, or read the board's Activity Log instead.

**The scratch goal** (checks 286 to 293): made on the plan page (`/plan`, **New milestone**, belonging to the scratch board), so its entries name it; call it `<goal>` below, and note its id. **Mail:** a bulk attach to an **empty** goal mails every administrator, and the cards' assignees, a real "Plan created": check 291 runs only when check 290 has confirmed T2 is in the goal. No webhook check: the scratch board has none, and the two `card.updated` changes are covered by the tests.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 278 | 2285 | `DELETE /api/v1/cards/<T3>`; `GET /api/v1/cards/<T3>` and note `archivedAt`; `DELETE` again; `GET` again. Open the board's **Activity Log**. Then restore T3 from the **Archived** page | Both `DELETE`s `200` `{"success": true}`; `archivedAt` the same both times; one "Archived card" entry for T3; T3 back in To Do | A second entry, or a later `archivedAt` |
| 279 | 2299 | In T1's card window add a subtask "Probe step", tick it, then untick it. Open the board's **Activity Log** | "Completed subtask" `Probe step (on T1)`, then "Updated subtask" `Reopened Probe step (on T1)` | No entry for the untick |
| 280 | 2299 | Open "Probe step", change the title to "Probe step 2" and set a due date, **Save** | "Updated subtask" `Updated Probe step 2 (on T1): title, dueDate` | No entry, or other fields named (`completed` or `position` among them) |
| 281 | 2299 | Open "Probe step 2" and **Save** without changing anything | No new entry | A new "Updated subtask" |
| 282 | 2299 | Note the subtask's `id` (`GET /api/v1/cards/<T1>/subtasks`); `PUT /api/v1/subtasks/<id>` `{"position": 5}` | `200`; no new entry | An entry |
| 283 | 2291 | `POST /api/v1/dependencies/bulk` `{"chain": [<T1>, <T2>, <T3>]}`. Open the board's **Activity Log** | `201` `created: 2`; two "Added dependency" entries, `#<T2> now waits on #<T1>` on T2 and `#<T3> now waits on #<T2>` on T3; no "Added dependencies" | One entry with no card, or "Added dependencies" |
| 284 | 2291 | Send the same request again | `201` `created: 0`, `skippedAsDuplicate: 2`; no new entry. Then remove both links in the card windows of T2 and T3 | A new entry |
| 285 | 2288 | On the scratch board page, in the browser's console: `await fetch('/api/cards/<T1>', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({position: 99})}).then(r => r.status)`. Open the board's **Activity Log**. Then drag T1 within its column | `200`; no "Updated card" entry for either | "Updated card" naming `position` |
| 286 | 2289 | On the scratch goal's plan page, **Close**, then **Reopen** | "Closed milestone" `Closed milestone "<goal>"`, then "Reopened milestone", on the scratch board | No entries |
| 287 | 2289 | `PATCH /api/v1/milestones/<goal>` `{"name": "<goal> 2", "targetDate": "2026-12-31"}`; then send it again | First: "Updated milestone" `Updated milestone "<goal>": name, targetDate` (the name before the change). Second: `200`, no new entry | No entry, the new name in the entry, or a second entry |
| 288 | 2289 | In T1's card window pick the goal in the milestone picker; then pick none | "Added card to milestone" `Added "T1" to milestone "<goal> 2"`, then "Removed card from milestone" `Removed "T1" from milestone "<goal> 2"` | No entries |
| 289 | 2289 | `PUT /api/v1/cards/<T2>` `{"milestoneId": <goal>}` | One "Added card to milestone" for T2 (with the API badge on All Tasks); no "Updated card" | "Updated card" naming `milestoneId` |
| 290 | 2289 | **A gate.** `GET /api/v1/milestones/<goal>` | Its `cards` include T2. **If they do not, skip check 291**: a bulk attach to an empty goal would mail every administrator a real "Plan created" | — |
| 291 | 2289 | Only if 290 found T2 in the goal: `POST /api/v1/milestones/<goal>/cards/bulk` `{"cardIds": [<T1>, <T2>, <T3>]}`; then `DELETE` the same route with `{"cardIds": [<T1>, <T3>]}` | `attached: 2`, `skippedAlreadyIn: 1`; two "Added card to milestone" (T1, T3), none for T2; no "Plan created" mail; then `detached: 2` and two "Removed card from milestone" | Entries missing, one for T2, or a mail |
| 292 | 2289 | Open the scratch board in a second window (B). In the first, `DELETE /api/v1/milestones/<goal>` (it holds T2) | B's T2 loses its 🎯 chip within about two seconds without a reload; the Activity Log has "Deleted milestone" `Deleted milestone "<goal> 2"; 1 card on this board released` | B keeps the chip until reloaded, or no entry |
| 293 | all | With an administrator's key, `GET /api/v1/audit-log?boardId=<scratch>&action=milestone_*` | `milestone_created` from the set-up, then the entries of 286 to 292, each with the right `source` (`ui` from a page, `api` from the key) | A missing entry, or a wrong source |
| 294 | all | `GET /api/v1/openapi.json` | `info.version` `1.2.0`; the description holds items 86 to 90, and item 90 names card 2343 | A version change, or an item missing |

**Afterwards.** If check 292 failed or was not reached, delete the scratch goal (`DELETE /api/v1/milestones/<goal>`); then delete the scratch cards and the scratch board. The board's Activity Log shows its last 50 entries only; read the audit log (check 293) if earlier entries have scrolled off.

#### Going back to the previous image

Nothing is done to the database. The older image stamps a card archived again when it is archived a second time, losing the first archive time, records a second "Archived card" and tells the board's open pages. It records no untick and no subtask edit, and writes and announces a subtask save that changes nothing. `subtask_updated` entries already written stay, and the older image's pages read them as "Updated subtask", the label it already has. It writes one `api:dependencies_bulk_added` per bulk batch again, with no card; the per-link "Added dependency" entries already written stay and read as before. It records a position-only change on the web application's card update as "Updated card" and sends `card.updated` for it again. It records no goal change and no card put in a goal or taken out, writes a goal saved unchanged and a card put in the goal it is already in again, tells no board of a goal changed or deleted, and records a `milestoneId` on the API's card update as "Updated card" naming `milestoneId`, sending `card.updated` for it again (and counting it as work in the activity report). The goal entries already written stay; the older image has no label for them and reads them in words from their names, "Milestone updated", "Milestone card added" and so on.

### The Public API: Fields It Ignored, the Bulk Detach and the Board-Cards Listing

**Card 2287.** No migration, no setting, no new route or field. Three requests to the API ignored a field without a word, and answered as if they had done what was asked. `PUT /api/v1/cards/{id}` with a `columnId` saved the other fields sent and left the card in its column; `POST /api/v1/boards` with a `categoryId` made the board unfiled; and `PUT /api/v1/boards/{id}` with a `parentCardId` saved the other fields and left the board where it hung. Now a `columnId` other than the card's own is refused with `400` `columnId 14 is not this card's column (12): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`, and nothing in the request is saved; the card's own column, sent back, is accepted, so a card read from the API can still be sent back whole. A move has its own route, with its own answer and effects (completion, XP, mail, leaving a goal), and taking the field here would let a client holding a stale copy undo somebody's move. `position` on the same request is still ignored, whatever is sent, and is now documented so: a drag renumbers every card in the columns it touches, so a card read a minute ago is often sent back with an old position. `POST /api/v1/boards` now files the new board under its `categoryId`, as the dashboard's own create does, with the same checks: a category that does not exist is `404`, one that holds only boards the key's user cannot open `403`, and a value that is not an id `400`, where each made the board unfiled with `201`. A board update's `parentCardId` other than the board's own, `null` on a sub-board included, is refused with `400` `parentCardId 12 is not this board's parent card (none): …`, and nothing is saved: a board is put under a card, or taken out from under one, on the board page (card 2114 kept that off the API). The tracking wrapper's `create-board` now sends `-CategoryId`. The OpenAPI document stays `1.2.0`, with item 91 in its 2026-10-14 note.

**Owner to know (2287).** A request to `PUT /api/v1/cards/{id}` that sends a `columnId` other than the card's own, or to `PUT /api/v1/boards/{id}` that sends a `parentCardId` other than the board's own, is now refused with a `400` that names the value, the stored one and the right route, where the other fields in it were saved and these ignored. `position` on the card update is still ignored, now said so: reorder with `PUT /cards/{cardId}/move`. `POST /api/v1/boards` files the new board under `categoryId`, and a category that does not exist, that the key's user may not use, or that is not an id is now `404`, `403` or `400` where the board was made unfiled. The tracking workflow sends none of these today. No page uses these routes.

**Card 2290.** No migration, no setting, no new route or field. Archiving a card keeps its goal, and an archived card still holds the goal to its board: a change of the goal's board is refused with "Some cards in this milestone are not on that board (archived cards count too). Take those cards out of it first". The API's bulk detach, `DELETE /api/v1/milestones/{id}/cards/bulk`, which the tracking workflow's `remove-milestone-cards` uses, read live cards alone, so an archived card in the list was reported as `Card does not exist or is archived` and the whole batch was refused, where the single detach and the card window take it out. Now the bulk detach takes an archived card out too, with its "Removed card from milestone" entry and a live update to its board, as the single detach does, and skips and counts one that is not in the goal. A card that does not exist is reported as `Card not found`; an archived card on a board the key's user cannot edit is reported as one they cannot edit, by its id and with no title. The bulk attach still refuses an archived card. The OpenAPI document stays `1.2.0`, with item 92 in its 2026-10-14 note, and the detach's `200` description, which said no card of the batch was in the milestone, now says every card listed that was in it is in none.

**Owner to know (2290).** A bulk detach takes archived cards out of a goal. A goal whose only cards were archived can now be emptied, and the next bulk attach to it then sends the "Plan created" mail: that mail counts archived cards when it decides a goal was empty, so before this release such a goal could never be emptied through the bulk route and never mailed again.

**Card 2295.** No migration, no setting, no new route or field. The API's card listing, `GET /api/v1/boards/{id}/cards`, which the tracking wrapper's `cards` command and the hand-built stakeholder reports read, listed a board's columns in no set order, in practice the order they were made in, so a column moved on the board, or one added later between two others (a "Review" between In Progress and Complete), came in the wrong place, after Complete; and it read each column's cards in a query of its own. Now it lists the cards in the board's order, by column position (ties by column id) and then card position (ties by card id), in one query, and reads the subtask counts for the cards listed alone. An answer's fields are unchanged. The web application's card picker (choosing a card to hang a new sub-board under) breaks a tie of position by id too. The OpenAPI document stays `1.2.0`, with item 93 in its 2026-10-14 note.

**Owner to know (2295).** On a board whose columns were reordered, or had one added between two others, the API's card listing now comes in the board's order, so a report or script built on it sees the columns in a new order from the deploy on. A board never reordered lists as before.

**Owner to know (after the deploy).** The local `.agent` tracking wrapper (`create-board -CategoryId`) and its reference are newer than the copies in Workflow_Central by a large backlog. Export them there once this release is live, comparing each file first: the wrapper's `-CategoryId` help line says it files the board from this release on, and an older server ignores it.

#### After the deploy

On production, with your own API key. **The scratch board:** the one from checks 278 to 294 if it is still there, otherwise one of your own with no other members, **no webhooks**, and three scratch cards T1, T2 and T3 made by hand in To Do, with no assignee. Nothing here completes a card or sends mail. Keep the board and its cards for the later checks of this group and delete them at the end of the release's checks.

**The scratch goal** (checks 300 and 301): made with `POST /api/v1/milestones` `{"name": "Probe goal", "boardId": <scratch>}`; call it `<goal>` below. Cards go in through the single route only: a bulk attach to an empty goal mails "Plan created", and since card 2290 so does one to a goal emptied of its archived cards. No check here bulk-attaches.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 295 | 2287 | `PUT /api/v1/cards/<T1>` `{"title": "T1 probe", "columnId": <In Progress id>}`; then `GET /api/v1/cards/<T1>` | `400` `columnId <In Progress> is not this card's column (<To Do>): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`; T1 still "T1", in To Do; no new Activity Log entry | `200`, or the title saved (if `200`, rename T1 back to "T1") |
| 296 | 2287 | `GET /api/v1/cards/<T1>` and keep the answer. On the scratch board page, drag T2 above T1 (this renumbers To Do, so T1's stored position changes). Change `title` to "T1 again" in the kept answer and `PUT` the whole object back | `200`; one "Updated card" naming `title` alone; T1 in To Do at the position the drag gave it. Then rename it back to "T1" | `400`, or other fields named, or T1's position put back |
| 297 | 2287 | `PUT /api/v1/cards/<T1>` `{"position": 99}` | `400` `No valid fields to update`; T1's position unchanged (`position` is ignored here) | `200` with the position changed |
| 298 | 2287 | `POST /api/v1/board-categories` `{"name": "TEST 2287 - delete me"}` (note id G); `POST /api/v1/boards` `{"name": "TEST 2287 board - delete me", "categoryId": G}` (note its id); look at the dashboard once. **Straight away:** `DELETE /api/v1/boards/<that board>`, then `DELETE /api/v1/board-categories/G`. An empty grouping is listed to everyone, so the test grouping shows briefly on every user's dashboard until it is deleted | `201` with `categoryId` G; the test board shown under the test grouping; both deletes `200`, and neither is on the dashboard after | `categoryId` null, or either left behind |
| 299 | 2287 | `PUT /api/v1/boards/<scratch>` `{"name": "<its name>", "parentCardId": <T1>}`; `GET /api/v1/boards/<scratch>` | `400` `parentCardId <T1> is not this board's parent card (none): …`; `parentCardId` still null | `200` |
| 300 | 2290 | `POST /api/v1/milestones/<goal>/cards` `{"cardId": <T2>}`, then the same for T3; `DELETE /api/v1/cards/<T3>` (archive); `DELETE /api/v1/milestones/<goal>/cards/bulk` `{"cardIds": [<T2>, <T3>]}`; open the board's **Activity Log** | `200` `detached: 2`; two "Removed card from milestone" (T2, T3). Then restore T3 from the **Archived** page | `409` |
| 301 | 2290 | `DELETE /api/v1/milestones/<goal>/cards/bulk` `{"cardIds": [<T2>, 999999999]}` | `409`, `problems` `[{"cardId": 999999999, "reason": "Card not found"}]` | The old reason, or `200` |
| 302 | 2295 | `PUT /api/v1/cards/<T1>/move` `{"columnId": <In Progress id>}`; `PUT /api/v1/columns/<To Do id>` `{"position": 9}`; `GET /api/v1/boards/<scratch>/cards` | T1 (In Progress) listed before T2 and T3 (To Do, now last on the board). Then put To Do back with `{"position": 0}`, move T1 back to To Do and `DELETE /api/v1/milestones/<goal>` | T2 and T3 first |
| 303 | all | `GET /api/v1/openapi.json` | `info.version` `1.2.0`; the description holds items 91 to 93; `PUT /api/v1/cards/{cardId}`'s request schema lists `columnId` (only as held) and `position` (ignored), `POST /api/v1/boards`'s lists `categoryId`, `PUT /api/v1/boards/{boardId}`'s lists `parentCardId`, and `GET /api/v1/boards/{boardId}/cards`'s description gives the order | A version change, or an item or a field missing |

**Afterwards.** Delete the scratch goal if check 302 did not, then the scratch cards and the scratch board, unless a later release's checks still need them.

#### Going back to the previous image

Nothing is done to the database. The older image ignores a `columnId` on `PUT /api/v1/cards/{id}` and a `parentCardId` on `PUT /api/v1/boards/{id}` again, saving the other fields sent with them and answering `200`, and makes a board sent to `POST /api/v1/boards` with a `categoryId` unfiled. A board already filed through the API stays filed. The wrapper's `create-board -CategoryId` is then ignored by the server. The older image's bulk detach refuses a whole batch that lists an archived card again, reporting it as `Card does not exist or is archived`; archived cards already taken out of goals stay out. Its card listing lists the columns in the order they were made in again, reading each column on its own.

### The Plan Page: Failures Said, the Picker's Search, the Unordered Cards' Box and a Confirmed Remove

**Cards 2314, 2319, 2321, 2322, 2323 and 2335.** No migration, no setting, no route; the plan page's code only. A change to the goal (rename, Close, target date, a card added or taken out) or a card opened that got no answer said nothing; each now says "No answer from the server…", and a refusal is said in the server's words (an opened card's refusal said "Could not open that card" whatever the server said). A change that failed is said in a toast as well as above the blocks, so it is seen from a ✕ far down the page. An answer that is not what was asked for (a proxy's page) says the server's answer could not be read. The card picker no longer stays on "Searching…" when its box is emptied quickly, no longer shows an older search's answer under a newer one, and says a search that failed instead of leaving the older results. The cards nobody sequenced, under the graph, have their box back (background, border, padding), lost since September to the button reset. The burndown no longer stays on "Loading the burndown…" when its read gets no answer, and a chart left from an earlier read is marked as no longer current. Unused code and styles left by the split are gone. The plan is `docs/planning/cards-2314-2319-2321-2322-2323-2335-plan-page.md`.

**Owner to know.** Taking a card out of a goal with the work table's ✕ now asks first, in the app's confirm dialog: **Remove From Goal**, naming the card and the goal, with **Cancel** and **Remove**. The ✕'s tooltip reads "Remove from this goal".

#### After the deploy

On production, as your own account, with a browser's developer tools' network panel. Nothing here completes a card or touches a real goal.

**The scratch board and goal.** On the dashboard make a board "TEST plan page - delete me", with no other members and **no webhooks**, and in its To Do three cards S1, S2 and S3, with no assignee. Open S2 and record that it is blocked by S1; leave S3 with no dependencies. On **Plan**, **New milestone** "Probe plan goal" on the scratch board, with no target date. On its plan page add S1, S2 and S3 one at a time with **+ Add cards** (the picker's single adds; no check here bulk-attaches, which mails "Plan created" for an empty goal). Every check below is on this goal's plan page.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 304 | 2314 | Set the network panel to **Offline** and click **Close** in the header. Set it back to **No throttling** | "No answer from the server. It is not known whether that change was saved." above the blocks and in a red toast; Close clickable again; the goal still open after a reload | Nothing said |
| 305 | 2314 | **Offline** again, click S1's title in **The work**, then back to **No throttling** | A red toast "No answer from the server. The card could not be opened."; no window opens | Nothing said |
| 306 | 2319 | Open **+ Add cards**, type a letter and clear the box straight away | Nothing under the box | "Searching…" stays |
| 307 | 2319 | Type `TEST plan` and wait for the results; set **Offline** and type one more letter; then back to **No throttling** | "No answer from the server. The search could not be run."; the earlier results gone | The earlier results still listed, or nothing said |
| 308 | 2321 | Look under **Parallel / unordered**, below the graph | S3 in its own box: a background, a border, rounded corners, padding; the border turns indigo under the pointer | Bare lines of text |
| 309 | 2322 | In the network panel block the address `/api/burndown` (right-click it, **Block request URL**) and reload the page | "No answer from the server. The burndown could not be loaded." in the Burndown panel | "Loading the burndown…" stays |
| 310 | 2322 | Unblock it and reload: the chart is drawn. Block `/api/burndown` again and set a target date in the header (the burndown is read again when the target date changes; a column change does not) | The chart stays, with "No answer from the server. The burndown could not be loaded. What is shown is from an earlier read and may no longer be current." under the verdict, above the time to deliver and the chart. Unblock it and clear the target date again: the note goes | No note over the old chart |
| 311 | 2335 | Click S3's ✕ in **The work**; **Cancel**; click it again and **Remove**; then add S3 back with **+ Add cards** | A dialog "Remove From Goal" naming S3 and "Probe plan goal"; Cancel leaves S3 in the goal; Remove takes it out; it comes back with + Add cards | S3 taken out on the first click |

**Afterwards.** With your API key, `DELETE /api/v1/milestones/<Probe plan goal's id>` (its id is in the plan page's address); then delete the scratch board from the dashboard, unless a later release's checks still need them.

#### Going back to the previous image

Nothing is done to the database. The older image says nothing again for a change or an opened card that gets no answer, and "Could not open that card" for any refusal; its picker can stay on "Searching…" and show an older search's answer; its unordered cards are bare text; its burndown can stay on "Loading…"; and its ✕ takes a card out of a goal on the first click.

### The Admin Page, the Dashboard and All Tasks: Fixes Left by the Split

**Cards 2305, 2306, 2308, 2309, 2313, 2316, 2317 and 2336.** No migration, no setting, no route; the three pages' code only. On the admin page's Scheduled Backups, **+ Add Destination** and **✏️ Edit** each close the other's form: the two share one set of fields, and with both open a name typed in the add form let the edit form's Save replace the destination being edited with the new one. Both buttons are off while a destination is being saved, and the save's answer closes and empties only the form that sent it. The edit form's hint for a Google Drive destination not yet connected names the button as it is labelled, "🔗 Connect" (it said "Connect Google Account"). The mail panel's green line after Save or Send Test is no longer cleared early by an earlier one's timer, and its timer ends with the page. All Tasks' Archived Cards and Activity Log say when their read failed, "No answer from the server. The archived cards could not be loaded." (or the server's own words, or that its answer could not be read), where each said there were none. The dashboard's "New Request" toast knows each request by its id: a request handled and a new one arriving between two of its 30-second reads raised no toast, and a request confirmed by its requester after it was made could be announced under another's title. Code and styles the split left unused on the three pages are gone. The plan is `docs/planning/cards-2305-2306-2308-2309-2313-2316-2317-2336-page-fixes.md`.

**Owner to know (2309).** **Admin → Team Management** now has a role picker, **Member** or **Owner**, beside **Add** once a person is chosen; it starts at Member. A team's owner can delete the team, rename it (through the API alone: no page offers it) and add and remove its members without being an administrator (the server always allowed it; no page could make anyone but the team's creator an owner). An owner can add any account, and each person added at once has the team's editor or viewer role on every board shared with the team, and the team's requests in their inbox; the board's owner has no say. Make someone an owner only where that is meant. The Teams page still adds members as Member. See [Admin Operations Guide](admin-guide.md#team-owners-and-members).

#### After the deploy

On production, as the superadmin, with the browser's developer tools. Nothing here completes a card, changes a backup destination or a real team, or mails anyone but a second account of your own.

**Scratch things.** A team "TEST team - delete me" made with **+ Add Team** on the admin page; a second account of your own (a scratch user made for this and deleted after, if you have none), not in the team.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 312 | 2305 | Admin, Scheduled Backups (with a destination listed): **✏️ Edit** on it, then **+ Add Destination**; **Cancel** | Only "Add Backup Destination" open, its boxes empty; the destination's row as before | Two forms open |
| 313 | 2305 | **+ Add Destination**, then **✏️ Edit** on a destination; **Cancel** | Only the edit form under the destination, with its settings | Two forms open |
| 314 | 2306 | Only if there is a Google Drive destination with OAuth not yet connected (its row shows **🔗 Connect**): **✏️ Edit** on it; **Cancel** | The hint reads `Save first, then use "🔗 Connect" on the destination.` | "Connect Google Account" |
| 315 | 2308 | Email / SMTP: **🧪 Send Test** to your own address; within five seconds of its green line, **Send Test** again | The second green line stays about 8 seconds | It goes within a few seconds |
| 316 | 2309 | Team Management, the scratch team: **Add member…**, choose the second account | A picker reading **Member** beside **Add** | No picker |
| 317 | 2309 | Choose **Owner**, **Add** | "Member added"; the second account listed as `OWNER`. Then ✕ it | Listed as `MEMBER` |
| 318 | 2336 | Dashboard open. Signed in as the second account in a private window, send yourself (the superadmin) a request "TEST 2336 A - delete me" from the request form; wait for its toast. Then, within a few seconds of each other and straight after a toast or a change of the header's count (so that both fall between two of the dashboard's 30-second reads): **❌ Reject** A in the Inbox (another tab), and send "TEST 2336 B - delete me". This confirms the new image toasts B; it cannot tell the two images apart, since the older one also toasts B whenever the two steps land in different reads | A "New Request" toast for B within 30 seconds; the header's count as before | No toast for B |
| 319 | 2317 | All Tasks, network panel **Offline**, **More → 🗄️ Archived Cards**; then **No throttling** and its Refresh | "No answer from the server. The archived cards could not be loaded."; Refresh lists the archived cards and the line goes | "No archived cards" |
| 320 | 2317 | With the Activity Log open, **Offline**, press its Refresh; then **No throttling** and Refresh again | "No answer from the server. The activity could not be loaded." above the list; it goes on the second Refresh | Nothing said |

**Afterwards.** Delete the scratch team (🗑️ in Team Management) and reject B in the Inbox. Delete the second account if it was made for these checks.

#### Going back to the previous image

Nothing is done to the database. The older image can open the add and the edit form of a backup destination together again, sharing their fields; names "Connect Google Account" in the Drive hint; can clear the mail panel's green line early; adds every team member as Member from the admin page (owners added since stay owners); says "No archived cards" or "No activity yet" for a read that failed; and toasts new requests by the count again.

### Deleted Groupings, the Card Search, Unchanged Board Saves and a Goal's Archived Cards

**Card 2293.** No migration file and no schema change; **it changes production rows at the first start of the new image**. Deleting a dashboard grouping (Manage Categories, or `DELETE /api/v1/board-categories/{id}`) deleted the grouping and nothing else. `boards.category_id` has no foreign key, so every board filed under it kept the deleted grouping's id: every page showed it as uncategorised, but both API trees answered the dead id in every board read, and a grouping later given the same id (which a restore onto another server can do) would have had those boards filed under it, hidden from its maker. Now the delete takes every board filed under the grouping out of it, sub-boards included, in the same transaction, leaving their `updated_at` as it is and recording and telling nothing. A start-up backfill clears any board whose grouping is not there, at every start and after every restore; at the first start after the deploy that is the one-off for the boards earlier deletes left behind. A restore treats `boards.category_id` as a foreign key: one that could not copy a grouping some board points at is refused, as for a real foreign key. The plan is `docs/planning/cards-2293-2327-2345-2346-data.md`. See [Data Model](data-model.md#key-schema-notes).

**Card 2345.** No migration, no setting, no route. A board save that changed nothing (the emoji picker choosing the emoji the board has, the dashboard's context menu choosing the grouping it is in, an API client sending a board back whole) wrote the board again with a new `updated_at`, put a false "Updated board" naming every field sent in the board's log and the activity report, moved the dashboard's last activity and made every open page of the board re-read. Now only the fields whose value changes are written, recorded and told, as for cards, comments, subtasks and goals (card 2183's rule): a save that changes nothing answers the board as it is, and one that changes some names only those. The page's `{}` no longer writes the row; v1's `{}` is still `400`; an editor who sends `isPublic` is still `403`.

**Card 2327.** No migration, no setting, no route or field; the internal `GET /api/cards/search` only, which the card window's dependency picker and the plan page's **+ Add cards** use. It read the first 60 title matches of every board, then dropped those on boards the caller cannot open, and cut the rest to 25: on a server with many private boards, a short or common search found few or none of an ordinary user's own cards. Now the boards the caller can open, "not archived", the card left out and the card's column being there are all asked in the query, before the limit; subtasks the same, in one read where it was three queries each. Results come in id order, as before. Administrators open every board and see no change. See [What a List Gives](authentication-security.md#what-a-list-gives).

**Card 2346.** No migration, no setting, no route; one field added to one answer. Giving a goal to a board (`PATCH /api/v1/milestones/{id}` with `boardId`) counts its archived cards, and the refusal names no card, but `GET /api/v1/milestones/{id}` listed only the cards that are not archived, so a caller had to look through every board's archived cards to find the one in the way. Now that read lists them in `archivedCards`, by card id, each as a `cards` item with `archivedAt`, withheld exactly as `cards` are (an archived card on a board the caller cannot open is its id alone, with `archivedAt` null). `cards`, the refusal's words and the web application's `GET /api/milestones/{id}` are unchanged. No page changes a goal's board, so no page changes. See [Critical-Path Planning](critical-path-planning.md).

**Owner to know.**

- **`DELETE /api/v1/board-categories/{id}` now takes its boards out of the grouping**, where the document said they kept its id (item 94 of the OpenAPI note). The page's confirm already promised it ("Boards using it will become uncategorised").
- **`PUT /api/v1/boards/{id}` sending values the board holds no longer logs `api:board_updated`** (item 95), and an entry names only the fields that changed. A client that read the audit log for a board update it made will find none when nothing changed.
- **An ordinary user's pickers find their own matches** that matches on boards they cannot open used to push out, and an answer's length no longer says anything about other boards.
- **`GET /api/v1/milestones/{id}` gains `archivedCards`** (item 96): additive, so a client that counts or walks `cards` sees no change. The wrapper's `get-milestone` prints the answer whole, so the new field shows there.
- **The boards check 321 lists are cleared at the first start**: each loses an id that names nothing. Each is already shown under Uncategorised, so no page changes; the API answers `categoryId: null` for them afterwards. One `WARN` line names them by id.

#### Before the deploy

**Check 321: boards filed under a grouping that no longer exists** (card 2293), read-only, on the host:

```bash
docker exec dumpfire node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || 'dumpfire.db', { readonly: true, fileMustExist: true });
const where = 'b.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM board_categories g WHERE g.id = b.category_id)';
console.log(db.prepare('SELECT COUNT(*) AS dangling FROM boards b WHERE ' + where).get());
console.table(db.prepare('SELECT b.id, b.name, b.category_id, b.parent_card_id FROM boards b WHERE ' + where + ' ORDER BY b.id').all());
db.close();
"
```

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 321 | 2293 | Run the query above immediately before the deploy; write down `dangling` and the board ids | A count, possibly 0, and a table of those boards. Each is already shown under Uncategorised on the dashboard; the deploy clears its dead id and changes nothing on screen | — (a record) |

Card 2327's checks need **T**, a scratch ordinary account of your own (made on the admin page for these checks and deleted after, if you have none), on no board of anyone else's. T signs in from a private window, so that O's session is kept.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 322 | 2327 | Signed in as T, make a board "TEST 2327 - delete me" with three cards titled `zq2327 e1`, `zq2327 e2`, `zq2327 e3`. Open the first, and in its Dependencies picker type `e` | A record only: write down how many of the other two are listed. Fewer than two (the fault) is likely if the server holds more than 60 cards with an `e` in the title on boards T cannot open | — (a record) |

A rehearsal (check 0c) on a copy of production, if one is run, gives the same count as the fourth figure of its `Filled in:` line, `<n> board(s) taken out of a grouping that no longer exists`, and names the first 50 on the line below it, `board <id> (grouping <id>), …`.

#### After the deploy

**O** is your own (administrator) account and API key. Nothing here touches a real board's grouping or a real board. Card 2345's checks use a scratch board of O's, "TEST 2345 - delete me", made on the dashboard for them and deleted after check 329. Card 2346's use two more of O's, "TEST 2346 X - delete me" and "TEST 2346 Y - delete me", made on the dashboard with one card each, T1 on X and T2 on Y, and a scratch goal; check 331 deletes all three. Nothing of these checks touches a real goal.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 323 | 2293 | First after the deploy: `docker logs dumpfire 2>&1 \| grep "grouping that no longer exists"` | If check 321 counted N > 0: one `WARN` "Took N board(s) out of a grouping that no longer exists", naming the first 50 by id. If 0: no such line | A count other than check 321's |
| 324 | 2293 | Run check 321's query again | `dangling` 0 and an empty table | Any row |
| 325 | 2293 | As O, dashboard **Manage Categories**: add "TEST 2293 - delete me"; make a board "TEST 2293 board - delete me" and file it under the grouping (its context menu). With your key, `GET /api/v1/boards/<id>`; then delete the grouping in Manage Categories (confirm); reload; with your key, `GET /api/v1/boards/<id>` again | Before the delete `categoryId` the grouping's id; after it, the board under Uncategorised and `categoryId` `null`. Delete the board afterwards | `categoryId` still the old id |
| 326 | 2327 | As T, open `zq2327 e1` on TEST 2327 and in its Dependencies picker type `zq2327` | `zq2327 e2` and `zq2327 e3` both listed (the first is the card itself, left out). Optionally repeat check 322's `e` search and compare with its record | Either missing |
| 327 | 2327 | As O, plan page **+ Add cards** on any goal, type `TEST` | Results as before (an administrator opens every board) | Fewer than before |
| 328 | 2345 | As O with your key, `GET /api/v1/boards/<TEST 2345 board>`, then `PUT` the same `name`, `emoji`, `categoryId` and `isPublic` back; open the board's **Activity Log** | `200`; `updatedAt` as in the `GET`; no new "Updated board" entry | A new entry, or `updatedAt` moved |
| 329 | 2345 | `PUT` `{"name": "TEST 2345 - delete me 2", "emoji": <its own>}`; open the **Activity Log** again. Then delete the board | One entry "Updated board … (fields: name)" | `emoji` named too |
| 330 | 2346 | As O with your key, `POST /api/v1/milestones` `{"name": "TEST 2346 goal - delete me"}` (no board); `POST /api/v1/milestones/<goal>/cards` `{"cardId": <T1>}`, then `{"cardId": <T2>}`; archive T2 (`DELETE /api/v1/cards/<T2>`); `GET /api/v1/milestones/<goal>` | `cards` holds T1 only; `archivedCards` holds T2 with its title, board Y, `withheld: false` and an ISO `archivedAt` | No `archivedCards`, or T2 in `cards` |
| 331 | 2346 | `PATCH /api/v1/milestones/<goal>` `{"boardId": <X>}`; then `DELETE /api/v1/milestones/<goal>/cards` `{"cardId": <T2>}`; then the `PATCH` again; then `GET /api/v1/milestones/<goal>` | `400` "Some cards in this milestone are not on that board (archived cards count too). …", the usual words; `200`; `200`; `boardId` X and `archivedCards` `[]`. Then `DELETE /api/v1/milestones/<goal>`, and delete boards X and Y on the dashboard (T2 goes with Y) | The second `PATCH` refused, or the refusal's words changed |
| 332 | all | `GET /api/v1/openapi.json` | `info.version` `1.2.0`; the 2026-10-14 note holds items 94 to 96; `MilestoneDetail` lists and requires `archivedCards`; `deleteBoardCategory`'s description says the boards are taken out | A version change, or an item missing |

**Afterwards.** Signed in as T, delete TEST 2327; as O, delete T if T was made for these checks. Check that nothing named "TEST 2293", "TEST 2327", "TEST 2345" or "TEST 2346" is left on the dashboard, and that no goal "TEST 2346 goal - delete me" is left on the plan page.

#### Going back to the previous image

The boards cleared stay cleared; the older image reads `null` as unfiled, as it always has. The older image leaves boards pointing at a deleted grouping again, and a restore on it commits boards filed under a grouping it could not copy. It also writes and records a board save that changes nothing again, naming every field sent, hides the caller's own search matches behind other boards' again, and answers a goal's read without `archivedCards`; a client that reads that field gets none, and finds a goal's archived cards by `GET /api/v1/boards/{boardId}/cards?archived=true` as before. Nothing stored changes either way.

### The Card Window and the Confirm Dialog

**Card 2353.** No migration, no setting, no route; one shared component, `ConfirmModal.svelte`, the confirm dialog of the plan page's Remove From Goal, the dashboard's Delete Board, All Tasks' and To Do's Archive Card, the board page's confirms (Archive Card, Delete Column, Link Board, Delete Sub-board, Delete Permanently, and **Cannot Complete**) and the Teams page's Delete Team. It moved no keyboard focus: the focus stayed on the button that opened it, behind the overlay, Tab walked the page behind, and nothing gave the focus back when it closed. Now **Cancel** takes the focus as the dialog opens; Tab and Shift+Tab go between its two buttons and no further, and Tab from anywhere outside it (after a click on the overlay, say) comes back to Cancel; and as it closes the focus goes back to the button that opened it, one turn of the browser's event loop later, if that button is still on the page and nothing else has taken the focus. A card window the dialog opens (Cannot Complete's **Open Card**) keeps the focus its title takes, and an opener the action removed (a deleted board's or team's button, an archived card's window) is passed over. The dialog's message is tied to it (`aria-describedby`), so a screen reader that lands on Cancel reads what is being confirmed. The admin page's, the Archived page's and three admin panels' own confirms are not this component and are unchanged. The plan is `docs/planning/cards-2337-2338-2341-2342-2353-card-window.md`.

**Card 2338.** No migration, no setting, no route; the card window's Comments tab and its key handling. A comment's **Delete** sent the delete on one click, and a deleted comment cannot be got back. Now it opens the confirm dialog above, drawn inside the card window: "Delete Comment", "This comment will be deleted for everyone on the card. This cannot be undone.", and **Delete**; for an administrator deleting someone else's comment, "<author>'s comment will be deleted for everyone on the card, and the Activity Log will record that you deleted it. This cannot be undone." Cancel or Escape closes it and sends nothing. The card window left Escape and Ctrl+Enter to a confirm only when it was outside the window, so Escape on this one would have closed the whole window; it now stands aside for any confirm open. A comment someone else deletes while the dialog is open is answered "Comment not found" in the window's message box, as a stale delete is today.

**Card 2342.** No migration, no setting, no route; the card window's Comments tab. A post read the box as it went and emptied it when the answer came, so anything typed while it was out was lost; and nothing marked a post as out, so a second click on **Post Comment**, or a second Ctrl+Enter, posted the comment twice. Now the box is emptied as the post goes, and Post Comment is greyed out and Ctrl+Enter sends nothing until it is answered. A post refused or not answered says so as before and puts its text back in the box, in front of anything typed since with a blank line between.

**Owner to know (2353).** **Enter pressed straight after a confirm opens now cancels it**, where it pressed the page's button behind the dialog again. Confirming by keyboard is now Tab, then Enter.

**Card 2337.** No migration, no setting, no route or field; the card window's Files tab, its two routes and three pages' live wiring. Attaching a file to a card, or deleting one, wrote the row and nothing else: no entry in the board's log, and no live update, so another person's card window kept a deleted file, or missed a new one, until it was opened again. Now an upload logs `attachment_added`, `Attached "<file name>" to "<card>"`, and a delete logs `attachment_deleted`, `Deleted the file "<file name>" from "<card>"`, each by whoever did it (labels "Attached file" and "Deleted file"), and each sends the board `{type: 'attachment', cardId}` once committed. A card window on the board page, All Tasks or All To Do that has read its files (its Files tab opened once) reads them again quietly when told, or after a reconnect or a return to the tab. The two writes are now a service, `src/lib/server/card-attachments.ts`, called inside each route's transaction; the files on disk are handled as before. The activity report counts both entries as work on the card. See [Notifications](notifications-email.md) and [Admin Operations Guide](admin-guide.md).

**Owner to know (2338).** **Deleting a comment now takes a second click**, on the dialog's Delete.

**Owner to know (2337).**

- **A second person's Files tab now shows a new file, or loses a deleted one, within about a second**, and its count follows.
- **A file's name now stays in the board's Activity Log and the administrator's Audit Log after the file is deleted**: both entries quote it (without any invisible formatting characters, which are left out of the entry so a name cannot reorder its line). Delete a file uploaded by mistake promptly, knowing its name remains in the log.
- **No webhook is sent for either entry.** An empty `events` list on a webhook means every event, so a new `attachment.*` event would start reaching existing receivers unannounced; and a receiver could not fetch the file, since attachments are not in the API. `GET /api/v1/audit-log` can now return the two action names (item 97 of the OpenAPI note).

#### After the deploy

On production, as **O**, your administrator account. Nothing here touches a real board or team. Everything is done on a scratch board of O's, "TEST 2337 - delete me", made on the dashboard with a card "TEST card", and a scratch team made in check 333; both are deleted afterwards.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 333 | 2353 | On **Teams**, create a team "TEST 2353 - delete me" and press its delete button. Press Tab, Tab, then Shift+Tab; then Escape. Then delete the team for real | The dialog opens with a focus ring on **Cancel**; Tab goes to **Delete**, Tab again back to **Cancel**, Shift+Tab to **Delete**; Escape closes it and the focus ring is back on the team's delete button | The focus stays behind the dialog, Tab reaches the page behind, or nothing has the focus after Escape |
| 334 | 2353 | On the scratch board, give TEST card an open subtask and drag it into the Complete column; in **Cannot Complete** press **Open Card** | The card window opens with the cursor in its title | The focus lands on the board behind the window |
| 335 | 2353 | Open TEST card, press **Archive** in its window, then **Cancel** in the dialog | Back in the window with the focus on Archive | The window closed, or the focus lost |
| 336 | 2338 | Post a comment on TEST card; press its **Delete**. Look at the dialog, press **Cancel**; Delete again and press Escape; Delete again and press **Delete** | A dialog "Delete Comment" covering the whole screen (not clipped to the card window), focus on Cancel; Cancel and Escape each close it with the comment and the window still there; Delete removes the comment | One click deletes; Escape closes the window; the dialog is cut off by the window |
| 337 | 2338 | Signed in as **T** (a scratch ordinary account of yours, added to the scratch board as an editor, signed in from a private window), post a comment on TEST card; as O, open the card and press Delete on T's comment; **Cancel** | The message names T and the Activity Log | O's own wording, or no dialog |
| 338 | 2342 | As O, in the browser's network panel choose **Slow 3G**. On TEST card type a comment, press **Post Comment** twice quickly, then type "more" while it is out. Set **No throttling** | The box empties at the first press and the button greys out; one comment posted; "more" still in the box afterwards | Two comments, or "more" gone |
| 339 | 2342 | Set **Offline**; empty the box, type "offline test" and press Post Comment; set **Online** | "No answer from the server…" in the window and "offline test" back in the box | The text gone |
| 340 | 2337 | O in one browser, T in the private window, both with TEST card open on the **Files** tab with one file already attached by O. As O attach a second file; then delete it. Open the board's **Activity Log** | T's tab shows the new file within about two seconds and its count rises; then loses it and the count falls. The log has "Attached "<name>" to "TEST card"" and "Deleted the file "<name>" from "TEST card"", both by O | T's tab unchanged until reopened, or no entries |
| 341 | 2337 | With O's key, `GET /api/v1/audit-log?action=attachment_*&boardId=<scratch board>` | The two entries, `source` `ui`, `rawAction` without `api:`; no webhook was sent for either (if the board has a scratch webhook, its receiver saw none) | No entries, or a webhook for either |
| 342 | all | `GET /api/v1/openapi.json` | `info.version` `1.2.0`; the 2026-10-14 note holds item 97 after 96, and the Attachments paragraph names the two actions | Item missing or version changed |

**Afterwards.** After check 341, delete the scratch board "TEST 2337 - delete me" on the dashboard (T's comment and the file attached before check 340, its starting state, go with it; the second file was deleted during the check), and check that no team "TEST 2353 - delete me" is left on Teams. Delete T if it was made for these checks.

#### Going back to the previous image

Nothing is done to the database. The older image's confirm dialog leaves the focus on the button behind it again, lets Tab walk the page behind, gives nothing back when it closes, and does not tie its message to it. Its card window deletes a comment on one click again, can post a comment twice, and loses what is typed while a post is out. It records no attachment entries and sends no attachment event, and leaves those written in place, readable, the label falling back to the raw action name; a second person's Files tab no longer follows.

### Small UI Fixes: the Plan Page's Reads and Typing, All Tasks' Pulse, Manage Categories, a File's Delete and the Admin Confirms

**Cards 2350, 2351, 2352, 2356, 2358, 2360 and 2362.** No migration, no setting, no route; pages' code only, and one new client module, `src/lib/dialog-focus.ts`. The plan is `docs/planning/cards-2350-2351-2352-2356-2358-2360-2362-ui.md`.

- **2350.** On a plan page, two cards opened quickly opened whichever card's read answered last, the first if it was slower; and two burndown reads close together showed whichever answered last, the first to answer ending "Loading the burndown…" while the other was out. Now only the latest read is used: one overtaken opens nothing and says nothing.
- **2351.** A card added from **+ Add cards**, or a rename of the goal, that was refused or got no answer emptied the box anyway. Now what was typed stays (the search and its results; the name box open with the new name) until the change is saved; the failure is said as before.
- **2352.** Two hover rules written twice in the plan page's work table and critical path are written once. Nothing changes on screen.
- **2356.** All Tasks' Activity Log: when its first read failed, the next read marked every item as new and the whole list pulsed for 30 seconds. Now a failed read changes nothing that was seen. The 30-second pulse timers end with the page.
- **2358.** The dashboard's **Manage Categories** said nothing when making, renaming or deleting a grouping was refused, and a change that got no answer left every button of the window dead until it was closed. Now the window says the server's words, or "No answer from the server. The category may not have been created." (saved, deleted), under its header, and what was typed stays.
- **2360.** A file's delete in the card window's Files tab sent the delete on one click.
- **2362.** The admin page's confirm (Clear Cards, Clear Categories, Delete Board, Delete User, Delete Team, Remove Destination, Purge Archived Cards, Vacuum Database, Reset All XP, Reset Everything) and the Archived page's (Delete Permanently, Purge All) were dialogs of their own: the focus stayed on the button behind, Tab walked the page, Enter pressed the button behind again, and Escape did nothing. Both are now the app's confirm dialog (card 2353's rules). The Import Database dialog and Google Drive's Connect box keep their own look and get the same behaviour: Cancel takes the focus, Tab stays in the dialog, Escape is Cancel, and the focus goes back to the button that opened it. The invite link's dialog and the reset's notice, which have one button and no way out but it, are unchanged.

**Owner to know.**

- **Deleting a grouping in Manage Categories, and a file in the card window, asks in the app's dialog**: "Delete Category" (where the browser's own confirm asked) and "Delete File", each naming what goes. Deleting a file now takes a second click.
- **The admin page's and the Archived page's confirms look like the rest of the app's** (centred, with the warning icon). **Enter straight after one opens cancels it**, as everywhere since card 2353: confirm by keyboard with Tab, then Enter. A click on the Archived page's dark overlay no longer cancels (no other confirm does); Cancel or Escape does. See [Admin Operations Guide](admin-guide.md#the-admin-pages-dialogs-and-the-keyboard).

#### After the deploy

On production, as **O**, your administrator account (also the superadmin for check 352), with the browser's developer tools' network panel, except check 351, which is **Local**: a local instance of this build started with `DB_PATH` set to a scratch file, never production's database, as check 219. Nothing here completes a card, touches a real goal, grouping, file or board, or imports anything, and no confirm dialog's **Confirm** is pressed: Enter is never pressed on Confirm. **Scratch things:** on the dashboard a board "TEST 2350 - delete me" with no other members and no webhooks, and in its To Do three cards S1, S2 and S3; on **Plan**, **New milestone** "TEST 2350 goal - delete me" on that board, S1 and S2 added with **+ Add cards** one at a time (S3 left out); a small text file attached to S1 (Files tab).

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 343 | 2350 | A smoke check only: under even throttling the two reads answer in the order sent, so it cannot tell the new image from the old (the jsdom cases hold the out-of-order answer). On the scratch goal's plan page, network panel **Slow 3G**: click S1's title in **The work**, then at once S2's; **No throttling** | The card window opens on S2 and stays on S2; no toast | It ends on S1 |
| 344 | 2351 | **+ Add cards**, type `S3` and wait for the results; set **Offline** and click S3's result; **No throttling** | "No answer from the server. It is not known whether that change was saved." above the blocks and in a toast; `S3` still in the box and the results still listed. Then press **Done**, and reload: S3 not in the goal | The box emptied |
| 345 | 2351 | **Offline**; double-click the goal's name, type "TEST 2350 goal 2" and press Enter; set **No throttling** in the network panel; click back into the name box, then press Escape | The no-answer words, and the name box still open with "TEST 2350 goal 2". Moving the focus to the developer tools blurs the box; since card 2363 (below) that blur sends nothing more, so there is one no-answer toast (the older image sent the name again on the blur, with a second toast). Escape closes the box; after a reload the goal's name is unchanged | The box closed at once, or the goal's name changed |
| 346 | 2356 | **All Tasks**: first reload it with the Activity Log shut (so the log's first read is the one made below); **Offline**, **More → 📋 Activity Log**; **No throttling**, then its Refresh | "No answer from the server. The activity could not be loaded."; after Refresh the list, no row pulsing (an indigo bar at its left) | Every row pulsing |
| 347 | 2358 | Dashboard, **🏷️ Manage Categories**: **Offline**, type "TEST 2358 - delete me" under Create New and press **Add**; **No throttling**, press **Add** again | "No answer from the server. The category may not have been created." under the window's header, the name still typed; the second Add makes the grouping and the line goes | Nothing said, or Add dead |
| 348 | 2358 | Its 🗑️ (on the row's hover): **Cancel**; again and **Delete** | The app's dialog "Delete Category", `"TEST 2358 - delete me" will be deleted. Boards using it will become uncategorised.` (not the browser's); Cancel keeps it; Delete removes it | The browser's confirm, or one click deletes |
| 349 | 2360 | Open S1, **Files**, the file's delete; press Escape; again and **Delete** | "Delete File" naming the file, focus on Cancel; Escape closes the dialog only (the card window stays open); Delete removes the file | One click deletes, or Escape closes the window |
| 350 | 2362 | Admin, **Board Management**, the row of "TEST 2350 - delete me": its **Delete** button; press Tab, Tab, then Escape. Never press Enter while **Confirm** has the focus: nothing here is confirmed | The centred dialog "Delete Board", a focus ring on **Cancel**; Tab to **Confirm**, Tab again back to Cancel; Escape closes it, the board still listed, the focus back on its Delete | No focus, Tab reaches the page, or Escape ignored |
| 351 | 2362 | **Local**, as the local instance's superadmin (never on production): Admin, **Import Database**; Tab three times, then Escape. Never press Enter while **Confirm** has the focus | Focus on **Cancel**; Tab goes to **Confirm**, then to the chosen way to restore, then back to Cancel; Escape closes it and no file picker opens; the focus back on Import | No focus, or Escape ignored |
| 352 | 2362 | Only if a Google Drive destination is listed under Scheduled Backups: its **🔗 Connect**; close Google's window without signing in; in DumpFire press Escape | The Connect box with the focus on Cancel; Escape closes it; nothing saved | Escape ignored |
| 353 | 2362 | Only if any card is archived: the **Archived** page, a card's **🗑️ Delete**; press Escape | "Delete Permanently" in the app's dialog, focus on Cancel; Escape closes it, the card still listed | Escape ignored |

**Afterwards.** With your API key, `DELETE /api/v1/milestones/<TEST 2350 goal id>` (its id is in the plan page's address); delete the board "TEST 2350 - delete me" on the dashboard (S1, S2, S3 and the file go with it); check that no grouping "TEST 2358" is left in Manage Categories.

#### Going back to the previous image

Nothing is done to the database. The older image can open an overtaken card or show an older burndown again, empties the picker and the name box whatever came back, lets the Activity Log pulse every row after a failed first read, says nothing in Manage Categories for a refused change and asks its delete with the browser's confirm, deletes a file on one click, and draws the admin page's and the Archived page's own confirms, and the import and Connect dialogs, without focus or Escape again.

### Small Server Fixes: Load More, Copied Comment Times, One Card Order, Unchanged Saves and Attachment Addresses

**Cards 2300, 2340, 2347, 2359 and 2361.** No migration, no setting, no route added; one new server module, `src/lib/server/card-order.ts`. Existing rows are not changed. The plan is `docs/planning/cards-2300-2340-2347-2359-2361-server.md`.

- **2300.** All Tasks' **Load more** under Complete wrote the address with the browser's own history call and re-read the page at the address SvelteKit still held, so the load got the old limit and the list never grew. It is now a navigation in place of the history entry, which loads 50 more and keeps SvelteKit's state.
- **2340.** Accepting a request copies its discussion onto the new card as comments; each copy was stamped with the time of the accept. Each now keeps the time its message was sent, and shows no "(edited)". Cards accepted before keep their times.
- **2347.** Cards at the same position came in no set order where a list runs across columns: All Tasks' and All To Do's buckets and both CSV exports. Every card list now orders by position, then by the order the cards were made. The board page, the sub-board picker and the API's card list already did.
- **2359.** Saving a column, a label, a card category or a dashboard grouping with the values it holds (the board page's column menu, the label picker, the category manager, Manage Categories, or the API sending a row back whole) still wrote it and told every open page of the board to re-read. Now it writes and tells nothing; a real change writes only what changed, as boards do since card 2345.
- **2361.** A file's address names its card, `/api/cards/<card>/attachments/<file>`, but the card was never read: the file was served, or deleted, under the address of any card the caller could reach. A file not on the card named is now `404 Attachment not found`. The card window builds the right address, so nothing changes on screen.

**Owner to know.** **Load more on All Tasks now loads more**: the Complete bucket grows by 50 each press, to 500 at most (the cap was already there; past it the button stayed and did nothing, which card 2366, in the next section, puts right: the bucket says how many it shows in place of the button). Because each press is now a page navigation, it also clears an error message that is showing, and when a new version has been deployed since the page was opened it reloads the page in full (losing the search, filters and sorts), as To Do's and the burndown's controls already do.

#### After the deploy

On production, as **O**, your administrator account, with the browser's developer tools' network panel and an API key of O's. Nothing here completes a real card or touches a real board, label or file. **Scratch things:** on the dashboard a board "TEST 2359 - delete me", then a board "TEST 2347 - delete me" (in that order), each with no other members; on TEST 2359, cards S1 and S2 in To Do, a small text file attached to S1 (Files tab), and a label "TEST label".

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 354 | 2300 | Only if All Tasks shows **Load more** under Complete: count the completed cards shown, press it | 50 more (or the rest) appear; the address ends `?completedLimit=100`; reload the page: the address keeps `?completedLimit=100` and the longer list stays | The count unchanged |
| 355 | 2340 | As check 318, signed in as a second account in a private window, send O a request "TEST 2340 - delete me" from the request form. As O, in the Inbox, open its **Discuss** and send "first note". Wait two minutes, then accept it into TEST 2359's To Do and open the new card's **Comments** | The copied comment ("first note") shows the time it was sent, two minutes or more ago, with no "(edited)" | "just now" on it |
| 356 | 2347 | With O's key, `POST /api/v1/boards/<TEST 2347 id>/cards` with `{"title":"TEST 2347 B","columnId":<its To Do id>}`, then the same again with "TEST 2347 A" (no position: both at 0). Download the all-boards export, `/api/cards/export/csv` | "TEST 2347 B" (made first) is on a row above "TEST 2347 A". This confirms the order but cannot catch the old fault, since cards tied in one column already came back in the order they were made; check 365 tests the exports' order. (Once card 2368, below, is deployed, both rows also sit among TEST 2347's rows, after every row of TEST 2359.) | A above B |
| 357 | 2359 | Open TEST 2359 in one tab, its network panel open, and keep that tab in front throughout (bringing a board tab to the front makes it re-read, so switching tabs would show a false read). From a terminal with curl and O's key, read its columns (`GET /api/v1/boards/<id>`); clear the network panel just before each send. Send `PUT /api/v1/columns/<its On Hold id>` with that column's own `title`, `color` and `position`; wait five seconds; send it again with `"color":"#0a0b0c"` | The first answers 200 with the column, and the tab reads nothing; after the second, one `contents` read in the tab and the column's colour changes | A `contents` read after the first |
| 358 | 2359 | The same, from the terminal with the tab in front, with `PUT /api/v1/labels/<TEST label id>` (its id from `GET /api/v1/boards/<id>/labels`) and `{"name":"TEST label"}` | 200 and no read in the tab | A read |
| 359 | 2361 | In S1's Files tab, copy the file's link (its id is the last number). In the address bar open `/api/cards/<S2 id>/attachments/<file id>`, then `/api/cards/<S1 id>/attachments/<file id>` | The first: a 404 error page saying "Attachment not found"; the second: the file | The file under S2 |
| 360 | 2361 | In the console on TEST 2359's page: `fetch('/api/cards/<S2 id>/attachments/<file id>', { method: 'DELETE' }).then((r) => r.status)` | `404`; the file still listed in S1's Files tab | `200`, or the file gone |

**Afterwards.** Delete both scratch boards on the dashboard (S1, S2, the file, the label, the two TEST 2347 cards and the accepted TEST 2340 card go with them). Deleting the board leaves the request itself, so "TEST 2340 - delete me" stays in the Inbox: as O, in the console, `fetch('/api/requests/<its id>', { method: 'DELETE' }).then((r) => r.status)` (`200`; administrators only). Delete the second account if it was made for these checks.

#### Going back to the previous image

Nothing is done to the database. The older image's Load more does nothing again; a request accepted under it stamps its copied comments with the accept (those copied under the new one keep their times); ties across columns come by column again in All Tasks, All To Do and the exports; an unchanged column, label, category or grouping save is written and told again; and a file is served or deleted under any card's address again.

### Small Server Fixes: Self-Assignment Mail, the 500 Cap, Request Thread Order, Export Row Order and Unmoved Columns

**Cards 2286, 2366, 2367, 2368 and 2369.** No migration, no setting, no route added or removed. Existing rows are not changed. The plan is `docs/planning/cards-2286-2366-2367-2368-2369-server.md`.

- **2286.** Assigning yourself to a card (the card window, picking yourself on a new card, accepting a task request onto yourself, or the API assigning its own key's user) mailed you "Assigned: <card>" about what you had just done. It no longer does; the assignment, its Activity Log entry and the board's refresh are as before, and anyone else assigned is still mailed.
- **2366.** All Tasks' Complete bucket stops at the latest 500 completed cards, but past that **Load more** stayed and loaded nothing. At the cap the button is gone and the bucket says "Showing the latest 500 of N completed cards".
- **2367.** A task request's discussion (the Inbox's Discuss and the requester's reply page) listed messages sent within one second in no set order. They are listed in the order they were sent, as the copy onto an accepted card already was.
- **2368.** Both CSV exports (the board export, `/api/boards/<id>/export/csv`, which no page links to, and the all-boards export behind All Tasks' **Export**, with or without its board filter) ordered rows by each card's position across every column, so a board's columns came mixed together, and the all-boards export mixed boards too. Rows now run board by board (in the order the boards were made), column by column in the board's order, then as each column shows its cards.
- **2369.** Saving the order of a board's columns (a column drag) wrote every column and told every open page of the board to re-read, even when nothing moved. Now only columns whose place changes are written, and a board is told only when one of its columns moved.

**Owner to know.** The all-boards export's rows are now grouped by board, oldest board first, where they were interleaved: a spreadsheet that relied on the old order (unlikely, since it was mixed) reads them in a new order. Check 356 above was reworded for this.

#### After the deploy

On production, as **O**, your administrator account, with the browser's developer tools (network panel and console) and an API key of O's. Nothing here completes a real card or touches a real board. Checks 361 and 362 need mail working and O's "Assigned" email setting on (My Account). **Scratch things:** a board "TEST 2368 - delete me" on the dashboard with no other members and its standard columns; on it, in this order, a card "TEST 2368 Prog" made in To Do and dragged into the empty In Progress column (never into Complete: completing a card gives real points that deleting the board does not take back), then "TEST 2368 Todo" in To Do, then cards S1 and S2 in To Do.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 361 | 2286 | Open S1's card window and assign O (yourself) | O shows on S1; the board's Activity Log shows "Assigned <O's name> to "S1""; no "Assigned: S1" mail reaches O's inbox within five minutes | The mail arrives |
| 362 | 2286 | With O's key, `POST /api/v1/cards/<S2 id>/assignees` with `{"userId": <O's id>}` (O's id from `GET /api/v1/me`) | `200` `{"success":true,"message":"User assigned"}`; no "Assigned: S2" mail within five minutes | The mail arrives |
| 363 | 2366 | Only if All Tasks' Complete header shows more than 500 in all ("x of N", N over 500): open `/all?completedLimit=500` | Under Complete, "Showing the latest 500 of N completed cards" and no **Load more**; the header reads "500 of N" (fewer with a search or filter on) | A Load more button |
| 364 | 2367 | As check 355, from a second account in a private window, send O a request "TEST 2367 - delete me". As O, on the Inbox, in the console: `for (const m of ['one', 'two', 'three']) await fetch('/api/requests/<its id>/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: m }) })`; then `fetch('/api/requests/<its id>/messages').then((r) => r.json()).then((l) => l.map((x) => x.id + ' ' + x.message))` | The three in the order sent, `one`, `two`, `three`, their ids rising (this confirms the order; the database already returned same-second messages in this order, so the older image passes too) | The three out of order |
| 365 | 2368 | In the address bar open `/api/boards/<TEST 2368 id>/export/csv` (the board export has no button); then press **Export** in All Tasks' header with no board filter | In the board's file, "TEST 2368 Todo", S1 and S2 (To Do) come before "TEST 2368 Prog" (In Progress), as the board shows them; in the all-boards file, TEST 2368's rows are together, with no row of another board between them | "TEST 2368 Prog" above "TEST 2368 Todo" (each is first in its column, at 0, and Prog was made first) |
| 366 | 2369 | Open TEST 2368 in one browser window with its network panel open, and the dashboard in a second window beside it, both visible (a board tab brought to the front re-reads, which would show a false read). In the dashboard's console: `const b = await (await fetch('/api/boards/<TEST 2368 id>/contents')).json(); const put = (u) => fetch('/api/columns/reorder', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updates: u }) }).then((r) => r.status); await put(b.columns.map((c) => ({ id: c.id, position: c.position })))`; wait five seconds; then `await put([{ id: b.columns[0].id, position: b.columns[1].position }, { id: b.columns[1].id, position: b.columns[0].position }])` | The first: `200`, and no `contents` read in the board window; the second: `200`, one `contents` read, and the first two columns swap places on screen | A `contents` read after the first |

**Afterwards.** Delete the board TEST 2368 on the dashboard (its cards go with it). Delete the request "TEST 2367 - delete me" as O, in the console: `fetch('/api/requests/<its id>', { method: 'DELETE' }).then((r) => r.status)` (`200`; administrators only), and the second account if it was made for these checks.

#### Going back to the previous image

Nothing is done to the database. The older image mails whoever assigns themselves again, shows Load more past 500 again, lists a thread's messages of one second in no set order again, mixes the exports' rows across columns and boards again, and writes every column of a reorder and refreshes the board again.

### Small UI Fixes: Team Roles, the Goal's Rename, the Activity Log's Reads, Three Dialogs and Show More

**Cards 2355, 2363, 2364, 2365 and 2370.** No migration, no setting, no route added or changed; pages' code only. Card 2355 uses what `POST /api/teams/{id}/members/{userId}` already did for someone already in the team: set their role. The plan is `docs/planning/cards-2355-2363-2364-2365-2370-ui.md`.

- **2355.** The Teams page added every member as Member, and no page could change the role of someone already in a team (it took ✕ and an add on the admin page). Now the Teams page has the admin page's role picker beside **Add**, starting at Member, and on both pages each member's role is a picker on their row: choosing **Member** or **Owner** saves it, "Role changed" says so, and a change refused or not answered is said and the picker shows the role they have again. A member taken out of the team meanwhile is put back in by the change, and that is what it says ("… was no longer in the team and has been added again as Owner"). On the Teams page the picker is where ✕ is: for an owner of the team or an administrator, not on your own row; on the admin page on every row.
- **2363.** On a plan page, renaming the goal with Enter and then clicking away before the answer sent the rename twice, and the click away after a refused rename sent the refused name again. Now a rename is not sent while one is out, a blur sends nothing for the name just sent (Enter sends it again), and nothing is sent once Escape has closed the box (a browser that blurs the box as it goes would have saved what Escape threw away).
- **2364.** All Tasks' Activity Log: two reads close together (the panel's Refresh, live events) showed whichever answered last, and the first to answer ended "Loading activity..." while the other was out. Now only the latest read is used; an overtaken one, even a failed one, changes and says nothing.
- **2365.** The dashboard's **Manage Categories** took no focus, had no name for a screen reader, let Tab walk the page behind it and ignored Escape. Now its name box under Create New has the focus as it opens, Tab stays in it, Escape closes it (except while a change is on its way; while a category's edit is open, when it cancels the edit; or while the delete's confirm is up, whose Escape closes the confirm alone), and the focus goes back to **🏷️ Manage Categories**. On the admin page, the invite link's dialog (an invite whose mail was not sent) and the reset's notice keep Tab in themselves, and the notice now takes the focus; the invite link still closes on **Done** alone, and the notice closes on Escape only when its button is **Close**.
- **2370.** All Tasks' **Show More (N remaining)** under Complete counted the loaded cards a search, the board filter or Hide blocked hid as still to come. With any of them on, the button now reads **Show More** with no number (how many older completed cards match is not known to the page); with none on, the number is as before.

**Owner to know.** **A team's owner can now change members' roles on the Teams page**, making someone else an owner, or another owner a member (the server always allowed both; card 2309's note on what an owner can do applies). See [Admin Operations Guide](admin-guide.md#team-owners-and-members).

#### After the deploy

On production, as **O**, your administrator account, with the browser's developer tools' network panel, except checks 373 and 374, which are **Local** (373 makes a live invite link, a credential, and 374 presses Reset Everything): a local instance of this build started with `DB_PATH` set to a scratch file, never production's database, as check 219. Nothing here completes a card, touches a real goal, team, grouping or board, or resets anything on production. **Scratch things:** on the **Teams** page, **New Team** "TEST 2355 - delete me"; a second account to add to it (one made for these checks, as check 355's, or any account: the scratch team has no boards and no requests, so being in it gives nothing); on the dashboard a board "TEST 2363 - delete me" with no other members and no webhooks, and on **Plan**, **New milestone** "TEST 2363 goal - delete me" on that board.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 367 | 2355 | Teams page, the scratch team: **Add member...**, choose the second account; set the picker beside **Add** to **Owner**; **Add** | A picker reading **Member** appears beside **Add** as the person is chosen; after Add, "Member added", and their row shows a picker reading **Owner** | No picker beside Add, or their row reading Member |
| 368 | 2355 | On their row choose **Member**; reload the page | "Role changed"; after the reload their row's picker reads **Member**. Your own row shows "owner" as a label, with no picker and no ✕ | Nothing said, or Owner after the reload |
| 369 | 2355 | Network panel **Offline**; on their row choose **Owner**; then **No throttling** | "No answer from the server. The role may not have been changed."; the picker reads **Member** again | The picker left on Owner |
| 370 | 2355 | **Admin → Team Management**, the scratch team: on the second account's row choose **Owner**; reload | "Role changed"; after the reload the row's picker reads **Owner** | No picker on the row, or Member after the reload |
| 371 | 2363 | On the scratch goal's plan page, network panel **Slow 3G**: double-click the goal's name, type "TEST 2363 goal 2", press Enter and at once click an empty part of the page; wait for the answer; **No throttling** | One `PATCH` to `/api/milestones/<id>` in the network panel; the name reads "TEST 2363 goal 2" | Two `PATCH` requests |
| 372 | 2363 | **Offline**; double-click the name, type "TEST 2363 goal 3", press Enter; when the toast shows, click an empty part of the page; click back into the name box and press Escape; **No throttling** | One "No answer from the server. It is not known whether that change was saved." toast and one failed `PATCH`; the click away sends nothing more; Escape closes the box, and the name still reads "TEST 2363 goal 2" | A second toast or `PATCH` on the click away |
| 373 | 2365 | **Local**, as the local instance's superadmin. First give it a mail server that does not answer (with none set up, an account with no password is refused and the dialog never appears): **Email / SMTP**, SMTP Host `127.0.0.1`, Port `2`, Username and Password empty, **Save SMTP**. Then under **User Management**, **+ Add User**, a username and an email and no password, **Create**. In the dialog "The invite mail was not sent": press Tab four times, then Escape, then **Done** | As it opens the focus is on **📋 Copy**; Tab goes from Copy to Done and back to Copy, never to the page behind; Escape leaves the dialog open; Done closes it, and the focus is then on **+ Add User** (Enter opens its form) | "Password must be at least 8 characters" (the mail server not saved), Tab reaching the page behind, Escape closing it, or the focus on nothing after Done |
| 374 | 2365 | **Local** (never on production): network panel **Offline**; **Reset Everything**, Tab, Enter on **Confirm**. In the notice "Reset not confirmed": press Tab twice, then Escape; **No throttling**; reload | The focus on **Close**; Tab stays on it; Escape closes the notice; after the reload everything is still there (the request never left the browser) | No focus, Tab reaching the page, or Escape ignored |
| 375 | 2365 | Dashboard, **🏷️ Manage Categories**: type "TEST 2365 - delete me" at once, without clicking; press Tab until the focus comes round to **×**; press Escape; press Enter, then Escape again | The name appears in the Create New box (it had the focus); Tab never leaves the window; Escape closes it, and the focus is back on 🏷️ Manage Categories: Enter then opens the window again | The typing lost, Tab reaching the page behind, Escape ignored, or Enter not opening it again |
| 376 | 2365 | Open it again, type "TEST 2365 - delete me" (the box starts empty) and press **Add**; its 🗑️ (on the row's hover); press Escape; then its 🗑️ again and **Delete** | Escape closes the "Delete Category" dialog alone, Manage Categories still open with the grouping listed; Delete removes it | Escape closing the window too |
| 377 | 2370 | Only if All Tasks shows **Show More (N remaining)** under Complete: type in the header's search the title of one completed card shown; clear it; choose a board in the board filter; choose all boards again | With the search on, the button reads **Show More** with no number; cleared, the number is back as it was; with a board chosen, no number again | A number while the search or the board filter is on |

**Afterwards.** On the Teams page delete the team "TEST 2355 - delete me" (its 🗑️, then **Delete** in the dialog). With your API key, `DELETE /api/v1/milestones/<TEST 2363 goal id>` (its id is in the plan page's address); delete the board "TEST 2363 - delete me" on the dashboard. Check that no grouping "TEST 2365" is left in Manage Categories. Delete the second account if it was made for these checks. Stop the local instance and delete its scratch database file.

#### Going back to the previous image

Nothing is done to the database: a role changed under the new image stays as it was set. The older image adds every member as Member on the Teams page and has no role picker on members' rows, can send a goal's rename twice, can show an older Activity Log read over a newer one, draws Manage Categories, the invite link's dialog and the reset's notice without their hold on the keyboard, and counts filtered-out cards in Show More again.

### Small Fixes: an Empty Board's Export, Column Order, a Team's Last Owner, Add Sent Once, Manage Categories' × and Role Pickers That Wait for Change

**Cards 2371, 2372, 2373, 2374, 2375 and 2376.** No migration, no setting, no route added. Two web-application routes answer differently (cards 2371 and 2373), and three `/api/v1` answers give tied columns in a set order (card 2372, OpenAPI change item 101, still version 1.2.0). The plan is `docs/planning/cards-2371-2376-small-fixes.md`.

- **2371.** The board CSV export (`/api/boards/<id>/export/csv`, which no page links to) of a board with no columns put the board's name in the file-name header as it was: a name with an emoji or another character outside Latin-1 was a `500`, and a double quote cut the name short. Now its file is named as any board's is, `<name>-<date>.csv` with every character but letters, digits, `-` and `_` made `_`.
- **2372.** A board's columns were read by position alone, so two at one position (a column made through v1 with a chosen `position`, or a reorder that sent one twice) came in no set order. Every reader now orders them by position, then the older first: the board page, All Tasks, All To Do, the inbox, the internal picker, the CFD, both CSV exports, the daily snapshots, the reports' To Do fallback, a board's columns in the graph view (`/api/graph?boardId=`, which gave them in the order they were made), and `GET /api/v1/boards/{boardId}`, `GET /api/v1/boards/{boardId}/columns` and `POST /api/v1/boards`.
- **2373.** A team's owner, or an administrator, could make the team's last owner a member or remove them, leaving a team only an administrator could run. Both are now refused for everyone: "A team needs at least one owner. Make someone else an owner first, or delete the team." (`409`, nothing changed).
- **2374.** **Add** under a team (the Teams page and **Admin → Team Management**) sent the add again on a second click while the first was out: two requests and two "Member added". Now a second press while it is out sends nothing, and Add keeps the keyboard's focus. An Add for someone already in the team (added meanwhile elsewhere) sets their role, and now says "*name* was already in the team; role set to *Role*" rather than "Member added".
- **2375.** Manage Categories' **×** closed the window while a change was on its way, so the server's answer was said to nobody (Escape already waited). Now × waits as Escape does.
- **2376.** The member role pickers (Teams page, admin Team Management) and the admin **User Management** role picker saved as soon as a value was chosen. On Windows, Up and Down on a closed picker choose at once, so a keyboard user arrowing through it saved each role passed (on User Management, Admin included). Now choosing saves nothing: each row has a **Change** button beside the picker, dimmed and doing nothing until a role other than the stored one is chosen, and pressing it saves. While it is on its way a second press sends nothing and a screen reader is told "Saving *name*'s role…". A role chosen and not saved is forgotten once the member or account is removed, or the page reads them back gone or already holding it. On User Management the picker and Change are drawn for the superadmin alone, as only the superadmin has a second role to give.

**Owner to know.** **Changing a role now takes a second step**: choose the role, then press **Change** on the row (on all three pickers). **A team can no longer be left with no owner**: to step down as a team's only owner, make another member an owner first, or delete the team. A team left with no owner from before (or by deleting its only owner's account, which this does not stop) is still run by administrators. See [Admin Operations Guide](admin-guide.md#team-owners-and-members).

#### After the deploy

On production, as **O**, your administrator account, on Windows in Chrome or Firefox (check 383's arrows choose at once there; on a Mac they open the list), with the browser's developer tools' network panel and an API key of O's. Nothing here completes a card or changes a real account, team, grouping or board. **Scratch things:** two boards on the dashboard, "TEST 2371 🚀 - delete me" and "TEST 2372 - delete me", each with its standard columns, no cards and no other members; on the **Teams** page, **New Team** "TEST 2373 - delete me" (O is its only owner); a second account to add to it (one made for these checks, or any account: the scratch team has no boards and no requests, so being in it gives nothing). **Check 383 runs only on an account made for these checks**, never a real one: on a faulty build its arrows send `PUT /api/users/<id>`, which makes the account an administrator for a moment and ends any invite sent to it and not yet used. With no such account, skip 383.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 378 | 2371 | On TEST 2371 🚀, delete every column: each column's **Column options** (on its header), **Delete column**, **Delete Column** in the dialog. Then in the address bar open `/api/boards/<its id>/export/csv` (the id is in the board's address) | A file downloads named `TEST_2371____-_delete_me-<today's date, YYYY-MM-DD>.csv`, holding the one line `Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks` | An error page, or an "Internal Error" answer, in place of the file |
| 379 | 2372 | With O's key, `POST /api/v1/boards/<TEST 2372 id>/columns` with `{"title": "TEST 2372 B", "position": 0}`; then `GET /api/v1/boards/<TEST 2372 id>/columns`; then open the board | `201`; the list gives To Do and then "TEST 2372 B", both at `position` 0, then the rest in their order; the board page shows To Do left of TEST 2372 B (this confirms the order; the database already gave the older column first in practice, so the older image passes too) | TEST 2372 B before To Do |
| 380 | 2373 | **Admin → Team Management**, the scratch team: on O's own row choose **Member** and press **Change**; then press ✕ on O's row | Both times the toast "A team needs at least one owner. Make someone else an owner first, or delete the team."; the picker reads **Owner** again and O's row stays | "Role changed", or O's row gone |
| 381 | 2374 | **Teams** page, the scratch team: **Add member...**, choose the second account; network panel **Slow 3G**; double-click **Add**; wait for the answer; **No throttling** | One `POST` to `/api/teams/<id>/members/<their id>` in the network panel; one "Member added"; their row shows a picker reading **Member** | Two `POST` requests or two "Member added" |
| 382 | 2376 | On their row, click the picker and press Escape to close its list (the picker keeps the focus); press the Down arrow once; look at the network panel; then press **Change** beside it; reload the page | The picker reads **Owner** and no request appears as the arrow is pressed; **Change** turns from dimmed to bright; after Change, "Role changed", and after the reload the picker reads **Owner** | A request to `/api/teams/…/members/…` as the arrow is pressed |
| 383 | 2376 | Only if O is the superadmin (the role picker and its **Change** are drawn for the superadmin alone; another administrator sees the role as its badge, with neither) and the second account was made for these checks; otherwise skip it. **Admin → User Management**, the second account's row (a user, not an administrator): click the role picker and press Escape; press the Down arrow, then the Up arrow; do not press Change | No request to `/api/users/…` in the network panel; the picker reads **User** again and its **Change** is dimmed | A `PUT` to `/api/users/<id>` as the arrows are pressed |
| 384 | 2375 | Dashboard, **🏷️ Manage Categories**; network panel **Slow 3G**; type "TEST 2375 - delete me", press **Add** and at once click **×**; wait for the answer; **No throttling**; click **×** | The window stays open after the first ×; once answered, "TEST 2375 - delete me" is listed; the second × closes the window | The window closing on the first × |

**Afterwards.** Delete the boards "TEST 2371 🚀 - delete me" and "TEST 2372 - delete me" on the dashboard. On the Teams page delete the team "TEST 2373 - delete me" (its 🗑️, then **Delete** in the dialog). In Manage Categories delete "TEST 2375 - delete me" (its 🗑️ on the row's hover, then **Delete**). Delete the second account if it was made for these checks.

#### Going back to the previous image

Nothing is done to the database: a role saved under the new image stays as it was set. The older image answers `500` for the export of an empty board whose name has an emoji, lists columns tied at one position in no set order, lets a team's last owner be made a member or removed, sends a second add on a double click, closes Manage Categories on × while a change is out, and saves a role as soon as it is chosen in a picker.

### The Plan Re-Read Only After a Change, Unused CSS Reported, a Team's Only Owner Kept on Account Delete, and a Missing Role Kept

**Cards 2324, 2357, 2377 and 2378.** No migration, no setting, no route added. Two web-application routes answer differently (cards 2377 and 2378); no `/api/v1` operation changes, and the OpenAPI document is as it was (version 1.2.0). The plan is `docs/planning/cards-2324-2357-2377-2378.md`.

- **2324.** Closing a card window on a plan page read the whole plan again every time, for a window only looked at too. Now it reads it again only when the window changed something the plan draws: a save that changed the card, a subtask ticked, added, edited or deleted, a dependency added or removed, or the card's milestone. An assignee, the cover, labels, a comment or a file changed in the window do not re-read it (the plan draws none of them).
- **2357.** The build's check for style rules that match nothing was switched off for the whole app; it is on again, and the one dead rule it found (on the request form page) is gone. Nothing on any page looks different.
- **2377.** Deleting an account that was the only owner of a team left that team with no owner, run by administrators alone. Now it is refused, nothing changed: "This account is the only owner of: *the teams*. Make someone else an owner or delete those teams first." ("… that team first" for one).
- **2378.** `POST /api/teams/{id}/members/{userId}` with no `role` set someone already in the team to Member, quietly demoting an owner (the pages always send a role, so only a script could). Now a role left out keeps theirs; someone new is still added as Member.

**Owner to know.** **An account that alone owns a team cannot be deleted** until another member is made an owner of each such team (**Admin → Team Management**, their row's picker, **Change**) or the team is deleted; the toast after **Confirm** names the teams. See [Admin Operations Guide](admin-guide.md#deleting-a-user). **On a plan page**, closing a card window you only looked at no longer reloads the plan.

#### After the deploy

On production, as **O**, your administrator account, with the browser's developer tools' network panel open (filter it to `__data.json` for checks 385 to 388; that is the plan's re-read). Nothing here completes a card or changes a real account, team or board. **Scratch things:** a board on the dashboard, "TEST 2324 - delete me", with its standard columns; in its To Do a card "TEST 2324 card - delete me" (in its window: Subtasks **Add**, title "TEST 2324 step", **Add Subtask**); on **/plan**, **New milestone**, name "TEST 2324 - delete me", board TEST 2324, **Create**; back in the card's window, **More options**, the **Milestone** picker, choose "TEST 2324 - delete me"; then open the goal's plan page (**/plan**, its row). For 389 to 391: in **Admin → User Management**, **+ Add User**, username "TEST 2377 - delete me", email `test2377@example.invalid`, a password (so no invite is mailed), role User, **Create**; in **Admin → Team Management**, **+ Add Team**, "TEST 2377 - delete me", **Create** (O is its owner); under it **Add member...**, choose TEST 2377 - delete me, the role picker beside it **Owner**, **Add**; then on O's own row choose **Member** and press **Change** (TEST 2377 - delete me is now its only owner).

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 385 | 2324 | On the plan page, in the work table, click "TEST 2324 card - delete me"; when its window is open press ✕ at its top right | The window closes and no `__data.json` request appears | A `__data.json` request as the window closes |
| 386 | 2324 | Open the card the same way and press **Save Changes** without changing anything | The window closes, no toast, and neither a `PUT` to `/api/cards/…` (with the filter cleared) nor a `__data.json` request appears | A `__data.json` request |
| 387 | 2324 | Open the card again; click the tick box beside "TEST 2324 step"; then press ✕ | No `__data.json` request as it is ticked (the tick's own `PUT` to `/api/subtasks/…` shows with the filter cleared); one `__data.json` request as the window closes; the Progress panel's "open subtasks / all" then reads 0/1 | No `__data.json` request after the close, or the tile still 1/1 |
| 388 | 2324 | Open the card again; add " renamed" to the end of its title; press **Save Changes** | The toast "Card updated"; one `__data.json` request; the work table shows "TEST 2324 card - delete me renamed" | No `__data.json` request, or the old title in the table |
| 389 | 2377 | **Admin → User Management**, on TEST 2377 - delete me's row press 🗑️, then **Confirm** in the dialog | The toast "This account is the only owner of: TEST 2377 - delete me. Make someone else an owner or delete that team first."; the account's row stays | "User deleted", or the row gone |
| 390 | 2377 | **Admin → Team Management**, the scratch team: on O's row choose **Owner** and press **Change** (note the request's address in the network panel, `/api/teams/<team id>/members/<O's id>`, for 391); then in User Management press 🗑️ on TEST 2377 - delete me's row and **Confirm** | "Role changed"; then "User deleted" and the row goes; the scratch team lists O alone, as Owner | A refusal naming the team |
| 391 | 2378 | On the admin page, in the developer tools' console, run `fetch('/api/teams/<team id>/members/<O's id>', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then(console.log)` with the two ids from 390; then reload the page | The console shows `{success: true, action: 'updated'}`; after the reload O's picker in the scratch team reads **Owner** | `A team needs at least one owner…` in the console (the older image read no role as Member) |

**Afterwards.** Delete the board "TEST 2324 - delete me" on the dashboard; its goal "TEST 2324 - delete me" belongs to the board and goes with it. In **Admin → Team Management** delete the team "TEST 2377 - delete me" (its 🗑️, then **Confirm**). If check 390 failed and TEST 2377 - delete me is still there, make O an owner of the scratch team, delete the team, then delete the account.

#### Going back to the previous image

Nothing is done to the database. The older image reads a plan again on every close of a card window, suppresses the unused-style check, deletes an account that alone owns a team (leaving the team with no owner), and reads a member sent with no role as Member.

### Goal Membership Webhooks, the Plan Re-Read After a Refused, Unanswered or Late Window Write, and the Sole Team Owner Named Before an Account Delete

**Cards 2343, 2379 and 2380.** No migration, no setting, no route added. One `/api/v1` change: two new webhook event types, OpenAPI change item 102 under version 1.2.0 (the version is unchanged). Cards 2379 and 2380 change page code only. The plan is `docs/planning/cards-2343-2379-2380.md`.

- **2343.** A card put in a goal or taken out recorded it on the card's board but told no webhook. It now sends `milestone.card_added` or `milestone.card_removed` to the webhooks of the card's board, by every way of doing it: the card window's **Milestone** picker, the plan page, and the API's single, bulk and card-update routes (one delivery per card for the bulk ones). The body is every event's: `data.cardId`, `data.action`, `data.source`, `data.user` and `data.detail` (`Added "<card>" to milestone "<goal>"`). A card moved from one goal to another is one `milestone.card_added` naming the goal it left. A change to a goal itself still sends nothing.
- **2379.** On a plan page, a card-window change that was refused because someone else had already made it (a dependency already removed), that got no answer, or that was answered after the window was closed, did not read the plan again, so the plan could show a link or a tick that was no longer true. Each now reads it again: the first two as the window closes, the last as soon as the answer comes.
- **2380.** Deleting an account that alone owns a team is refused (card 2377), but the confirmation did not say so. It now names those teams before **Confirm** is pressed.

**Owner to know.** **Every webhook whose events list is empty (sent every event) starts receiving `milestone.card_added` and `milestone.card_removed` from this deploy**, one delivery per card for a bulk change of up to 500 cards. A receiver that cannot take them should be given the list of events it wants (`PUT /api/v1/webhooks/{id}` with `events`) before or straight after the deploy. **In Admin → User Management**, the delete confirmation of an account that is the only owner of a team now says so in its second sentence; **Confirm** still sends the delete, and the server still refuses it unless someone else has been made an owner since the page was loaded.

#### After the deploy

On production, as **O**, your administrator account, with O's API key (My Account) and the browser's developer tools' network panel open (filter it to `__data.json` for checks 394 to 396; that is the plan's re-read). Nothing here completes a card or changes a real account, team, board or webhook receiver. **The receiver, `<CATCHER>`**: an HTTPS address you control that shows each request it gets with its headers and body, such as a request-catcher service you pick or a path on a server of yours, reachable from production and not inside the network (production refuses inside addresses); the one of card 2325's checks will do. Never a third-party address chosen for you. **Scratch things:** a board on the dashboard, "TEST 2343 - delete me" (note its id, the number in its address `/board/<id>`), with a card in its To Do, "TEST 2343 card - delete me"; on **/plan**, **New milestone**, name "TEST 2343 - delete me", board TEST 2343, **Create**. With O's key, `POST /api/v1/boards/<id>/webhooks` with `{"url": "<CATCHER>/2343"}` (no events: every event) and again with `{"url": "<CATCHER>/2343-joins", "events": ["milestone.card_added"]}`; note the two `id`s answered. For 394 to 396: a board "TEST 2379 - delete me" with two cards in its To Do, "TEST 2379 A - delete me" and "TEST 2379 B - delete me"; in A's window, Subtasks **Add**, title "TEST 2379 step", **Add Subtask**, then **More options**, **+ Add a blocker**, type "TEST 2379 B", choose it; on **/plan**, **New milestone**, "TEST 2379 - delete me", board TEST 2379, **Create**; in each card's window, **More options**, the **Milestone** picker, choose "TEST 2379 - delete me"; then open the goal's plan page (**/plan**, its row). For 397 and 398: in **Admin → User Management**, **+ Add User**, username "TEST 2380 - delete me", email `test2380@example.invalid`, a password (so no invite is mailed), role User, **Create**; in **Admin → Team Management**, **+ Add Team**, "TEST 2380 - delete me", **Create**; under it **Add member...**, choose TEST 2380 - delete me, the role picker beside it **Owner**, **Add**; then on O's own row choose **Member** and press **Change**.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 392 | 2343 | On the board TEST 2343 - delete me, open "TEST 2343 card - delete me", **More options**, the **Milestone** picker, choose "TEST 2343 - delete me" | `<CATCHER>/2343` and `<CATCHER>/2343-joins` each get one `POST` with the header `X-DumpFire-Event: milestone.card_added`, whose body has `"event": "milestone.card_added"`, `"boardId"` the board's id, and `data` with `"action": "milestone_card_added"`, `"source": "ui"`, `"user"` O's username and `"detail": "Added \"TEST 2343 card - delete me\" to milestone \"TEST 2343 - delete me\""`; note `data.cardId` | Nothing arrives, or a `card.updated` arrives instead |
| 393 | 2343 | With O's key, `PUT /api/v1/cards/<cardId from 392>` with `{"milestoneId": null}` | `200`; `<CATCHER>/2343` gets one `POST` with `X-DumpFire-Event: milestone.card_removed`, `data.action` `milestone_card_removed`, `data.source` `api`, `data.detail` `Removed "TEST 2343 card - delete me" from milestone "TEST 2343 - delete me"`; `<CATCHER>/2343-joins` gets nothing more | Nothing on `/2343`, a `card.updated`, or anything on `/2343-joins` |
| 394 | 2379 | On the TEST 2379 plan page click "TEST 2379 A - delete me" in the work table; in its window **More options** (Blocked by lists TEST 2379 B). In a second tab, open the board TEST 2379 - delete me, open card A, **More options**, ✕ on B's row there. Back in the first tab, ✕ on B's row in the window (its title reads "Remove this dependency"); then ✕ at the window's top right | "Dependency not found" above the lists and B's row gone from them; one `__data.json` request as the window closes; the plan then shows A no longer waiting on B (B's arrow gone from the graph) | No `__data.json` request at the close, or the arrow still drawn |
| 395 | 2379 | Open A's window again; in the network panel's throttling list choose **Offline**; click the tick box beside "TEST 2379 step"; choose **No throttling** again; press ✕ at the window's top right | "No answer from the server. It is not known whether that was saved." at the top of the window; one `__data.json` request as the window closes | No `__data.json` request at the close |
| 396 | 2379 | Open A's window again; in the throttling list choose **3G** (older Chrome: Slow 3G) (or a custom profile of 3,000 ms latency); click the tick box beside "TEST 2379 step" and at once, before the `PUT` to `/api/subtasks/…` has a status (filter cleared), press ✕ at the window's top right; wait; choose **No throttling** | No `__data.json` request as the window closes; one `__data.json` request that starts after the `PUT` has its `200` (the Waterfall shows it after) | No `__data.json` request after the `PUT`'s answer |
| 397 | 2380 | **Admin → User Management**, on TEST 2380 - delete me's row press 🗑️; read the dialog; press **Cancel** | The dialog reads "Delete user "TEST 2380 - delete me"? They are the only owner of: TEST 2380 - delete me, so the delete will be refused: make someone else an owner or delete that team first. Their comments, …"; after **Cancel** nothing is sent and the row stays | The dialog starts "Delete user "TEST 2380 - delete me"? Their comments" |
| 398 | 2380 | **Admin → Team Management**, the scratch team: on O's row choose **Owner** and press **Change**; then in User Management press 🗑️ on TEST 2380 - delete me's row; read the dialog; press **Cancel** | "Role changed"; the dialog reads "Delete user "TEST 2380 - delete me"? Their comments, …", with no "only owner" sentence | The sentence naming the team is still there (the page reads its teams again after **Change**) |

**Afterwards.** With O's key `DELETE /api/v1/webhooks/<each of the two ids>`, then delete the board "TEST 2343 - delete me" on the dashboard (its goal belongs to it and goes with it) and the board "TEST 2379 - delete me" likewise. Clear or delete the receiver's two paths: they hold card titles. In **Admin → Team Management** delete the team "TEST 2380 - delete me" (its 🗑️, then **Confirm**); then in User Management delete TEST 2380 - delete me (🗑️, **Confirm**: the dialog now names no team).

#### Going back to the previous image

Nothing is done to the database. The older image sends no webhook for a card put in a goal or taken out, and refuses a webhook created or changed with `milestone.card_added` or `milestone.card_removed` in its events (`400`); a webhook already saved with either keeps it and is sent neither. On a plan page it does not read the plan again after a refused, unanswered or late window change, and its delete confirmation does not name the teams an account alone owns (the delete is still refused).

### One Reader for Both Audit Logs, a Webhook for Every Card That Leaves a Goal, and the Card Window's Dependency Read When the Network Drops

**Cards 2294, 2381 and 2382.** No migration, no setting, no route added. One `/api/v1` change: `milestone.card_removed` is sent in more cases, OpenAPI change item 103 under version 1.2.0 (the version is unchanged); `GET /api/v1/audit-log` answers exactly as before. The plan is `docs/planning/cards-2294-2381-2382.md`.

- **2294.** The Audit page's log (`GET /api/audit`) and the API's (`GET /api/v1/audit-log`) were two copies of one query that had drifted apart. Both now read the log through one function. The page's route reads a page's board names in one query, where it asked once per board; takes `cardId`; refuses a bad id in the API's words (`Invalid board ID`, where it said `Invalid boardId`); and answers `rawAction`, `source`, `total` and `hasMore` as the API does. The page shows what it showed.
- **2381.** A card that left a goal because of something else (moved to another board, its goal deleted, or deleted itself, alone, with its column, by an administrator's **Clear Cards** or by **Purge All**) recorded nothing for the goal and told no webhook. Each now writes `milestone_card_removed` on the card's board, with why in brackets, and sends `milestone.card_removed`. A card deleted together with its own board still sends nothing: the board's webhooks go with it.
- **2382.** When the card window could not read a card's dependencies (no network, a proxy's page, a refusal), it said nothing and the browser logged an error. It now says so above the lists and keeps the links it was showing.

**Owner to know.** **Every webhook whose events list is empty (sent every event) starts receiving `milestone.card_removed` for these cases from this deploy**: one delivery per card, so an administrator's **Clear Cards** on a board of 400 cards in goals sends 400, and **Purge All** one per purged card that was in a goal. A receiver that cannot take them should be given the list of events it wants (`PUT /api/v1/webhooks/{id}` with `events`). A script that reads `/api/audit` with a bad id reads `Invalid board ID` (or `Invalid user ID`) where it read `Invalid boardId` (or `Invalid userId`).

#### After the deploy

On production, as **O**, your administrator account, signed in, with O's API key (My Account). Nothing here completes a card, purges archived cards, or changes a real board, card, goal or webhook receiver. **The receiver, `<CATCHER>`**: an HTTPS address you control that shows each request it gets with its headers and body, the one of card 2343's checks will do; never a third-party address chosen for you. **Scratch things:** on the dashboard two boards, "TEST 2381 - delete me" and "TEST 2381 other - delete me"; note each id (the number in its address, `/board/<id>`), called `<A>` and `<B>`. With O's key: `GET /api/v1/boards/<A>/columns` and `GET /api/v1/boards/<B>/columns`, and note each board's To Do column id (`<A-todo>`, `<B-todo>`); `POST /api/v1/boards/<A>/columns` with `{"title": "TEST 2381 col - delete me"}`, note its `id` (`<col>`); `POST /api/v1/boards/<A>/cards` four times, with `{"columnId": <A-todo>, "title": "TEST 2381 one - delete me"}`, then `two` and `three` likewise, and `{"columnId": <col>, "title": "TEST 2381 four - delete me"}`, noting each card's `id`; `POST /api/v1/milestones` with `{"name": "TEST 2381 - delete me", "boardId": <A>}`, note its `id` (`<goal>`), and `POST /api/v1/milestones/<goal>/cards` four times, with `{"cardId": <one>}`, then `<two>`, `<three>` and `<four>` (one at a time: the bulk attach to an empty goal mails every other administrator "Plan created"); then `POST /api/v1/boards/<A>/webhooks` with `{"url": "<CATCHER>/2381"}` (no events: every event), and note its `id`. Before each of checks 402 to 405, clear what the receiver shows, so that what each check sends is all it shows.

| # | Card | Do | Expect | A fault if |
|---|---|---|---|---|
| 399 | 2294 | With O's key, `GET /api/v1/audit-log?boardId=<A>&limit=2`; in the browser, signed in as O, open `/api/audit?boardId=<A>&limit=2` | Both answer the same two `id`s in `data`, newest first, and the same `pagination` (`"limit": 2`, `"count": 2`, the same `"total"`, `"hasMore": true`, `"defaultLimit": 100`, `"maxLimit": 500`); each row of both has `rawAction`, `source` and `"boardName": "TEST 2381 - delete me"`; the `/api/audit` rows' `action` begins `api:` (`api:milestone_card_added`), the v1 rows' does not | `/api/audit`'s `pagination` has no `total` or `hasMore`, or its rows have no `rawAction` |
| 400 | 2294 | In the browser, signed in as O, open `/api/audit?boardId=2.5`, then `/api/audit?cardId=<one>` | The first: an error page showing 400 and "Invalid board ID" (a page, not JSON: only `/api/v1/` answers a browser in JSON); the second lists only entries whose `cardId` is `<one>` | The first says "Invalid boardId", or the second lists entries of other cards |
| 401 | 2294 | The dashboard's **More** menu, **Audit & Logs**; the **Audit Log** tab; **Board** "TEST 2381 - delete me", **Action** `api:*`; **Apply** | Rows of that board only, each action shown with `api:` in front, among them `api:card_created` and `api:milestone_card_added` | A row whose action has no `api:`, such as `board_created` (the board was made on the dashboard) |
| 402 | 2381 | With O's key, `PUT /api/v1/cards/<one>/move` with `{"columnId": <B-todo>}` | `200` with `"milestoneId": null`; `<CATCHER>/2381` gets a `card.moved` and one `POST` with `X-DumpFire-Event: milestone.card_removed`, `"boardId"` `<A>`, `data.cardId` `<one>`, `data.source` `api` and `data.detail` `Removed "TEST 2381 one - delete me" from milestone "TEST 2381 - delete me" (moved to another board)` | No `milestone.card_removed` |
| 403 | 2381 | With O's key, `DELETE /api/v1/cards/<two>?permanent=true` | `200`; `<CATCHER>/2381` gets a `card.deleted` and a `milestone.card_removed`, each with `data.cardId` `<two>`, the second's `data.detail` `Removed "TEST 2381 two - delete me" from milestone "TEST 2381 - delete me" (card deleted)` | Only the `card.deleted` |
| 404 | 2381 | With O's key, `DELETE /api/v1/columns/<col>` | `200`; `<CATCHER>/2381` gets one `milestone.card_removed`, `data.cardId` `<four>`, `data.detail` `Removed "TEST 2381 four - delete me" from milestone "TEST 2381 - delete me" (card deleted)`, and no `card.deleted` | Nothing arrives |
| 405 | 2381 | With O's key, `DELETE /api/v1/milestones/<goal>` | `200` `{"success":true,"cardsReleased":1}`; `<CATCHER>/2381` gets one `milestone.card_removed`, `data.cardId` `<three>`, `data.detail` `Removed "TEST 2381 three - delete me" from milestone "TEST 2381 - delete me" (milestone deleted)` | Nothing arrives |
| 406 | 2382 | Open the board TEST 2381 - delete me; in the browser's developer tools, the network panel's throttling list, choose **Offline**; click "TEST 2381 three - delete me" to open its window; press **More options**; then choose **No throttling** again and press ✕ at the window's top right | Above **Blocked by**, "No answer from the server. The dependencies could not be loaded."; "Loading…" is not shown under **Blocked by** | Nothing is said, or "Loading…" stays |

**Afterwards.** With O's key `DELETE /api/v1/webhooks/<the id>`. On the dashboard delete the boards "TEST 2381 - delete me" and "TEST 2381 other - delete me" (card one is on the second). Clear or delete the receiver's path `/2381`: it holds card titles.

#### Going back to the previous image

Nothing is done to the database. The older image sends no `milestone.card_removed` for a card that leaves a goal because of a move to another board, a goal deleted or a delete, and writes no entry for it (entries written meanwhile stay, and read as a card taken out). Its `/api/audit` reads board names one by one, ignores `cardId`, refuses a bad id as `Invalid boardId`, and answers no `rawAction`, `total` or `hasMore`. Its card window says nothing when the dependencies cannot be read.

## Changing the Schema

The structure of the database is changed in one way only:

1. Add a new numbered file under `drizzle/`, named `NNNN_what_it_does.sql` with the next unused number, with `--> statement-breakpoint` between its statements.
2. Make the same change in the model, `src/lib/server/db/schema.ts`.
3. Run `npm run schema:expected`. It regenerates `src/lib/server/db/expected-schema.ts`, the copy of the model that the runner compares every database with.
4. Run `npm test`. The suite builds a database from the migration files and fails if it is not the model exactly, or if the expected schema is out of date. See [Testing](testing.md#the-expected-schema).

`npm run build` checks step 3 again before it builds, on a workstation and inside `docker build`, and stops if the expected schema is not what the model generates.

**The six reconciled tables are no exception to step 1.** Reconciliation rebuilds `boards`, `columns`, `categories`, `settings`, `user_xp` or `invite_tokens` whenever the table has the model's columns and differs from it in anything else, so a constraint changed in the model alone would reach every database at its next start with no migration recording it. A change to one of the six therefore ships a numbered file like any other, even where the file can only say what the rebuild will do and why (a comment and a statement that changes nothing, such as `SELECT 1;`). The file is what puts the change in the migration record, and it is what makes an older image recognise the database as newer than itself and leave those tables alone. The file that creates the table must be corrected as well, so that a new database is born in the new shape, as was done for the two `0001` files: the suite fails if a new database needs a rebuild.

What the runner requires of a migration file:

- **None of these statements**: `PRAGMA`, `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `VACUUM`, `ATTACH` or `DETACH`. The file already runs inside the runner's transaction, where each of them fails, ends the transaction early or, worst, does nothing without saying so. A file that contains one is refused before any of it runs, and the server stops. The `BEGIN … END` of a trigger's body is part of the `CREATE TRIGGER` statement and is allowed.
- **At least one SQL statement.** An empty or comment-only file is refused: once recorded it could never be given its SQL, because a recorded file is never run again.
- **No "already exists" or "duplicate column" error.** Those are tolerated only in a fixed list of 19 old files, none later than `0037`, where two series of migrations overlap. In any other file they stop the server, and nothing is ever added to the list.
- **A released file is never run twice.** A file is recorded by its name, so editing one changes new databases only, and renaming one makes every existing database run it again.

Two drizzle-kit commands must not be used to change a database:

- **Never run `drizzle-kit push` against a real database.** `push` compares the model with the database and alters the database directly. It drops tables the model does not declare, which is how the development database lost `time_entries`, and it rebuilds tables on the spot, which is how the same database came to have a half-finished `__new_report_schedules` left in it. None of it is recorded as a migration, so no other database receives the same change and the databases drift apart.
- **Do not apply `drizzle-kit generate` output as it comes.** To change a column's `NOT NULL`, primary key or foreign key, `generate` writes a table rebuild wrapped in `PRAGMA foreign_keys=OFF` and `PRAGMA foreign_keys=ON`. The runner refuses such a file, and has to: SQLite ignores `PRAGMA foreign_keys` inside a transaction without reporting an error, so inside the runner's per-file transaction foreign keys would stay on, and the `DROP TABLE` in the rebuild would delete the table's rows and every row that cascades from them. drizzle-kit's own journal (`drizzle/meta/_journal.json`) also stops at `0005`, so what it generates is every difference between the model and the schema as it stood then, not only the change just made.

A rebuild of a table that other tables refer to therefore cannot be delivered as a migration file. Rebuilds of that kind are done in code, as they are for the six reconciled tables: with foreign keys switched off outside any transaction and the whole database checked before the commit. See [Data Model](data-model.md#reconciliation-the-six-tables).

Under `npm run dev` a failed migration does not end the process. The dev server stays up and every request fails until the cause is fixed and the server is restarted.

## Reverse Proxy — Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name dumpfire.example.com;

    ssl_certificate     /etc/ssl/certs/dumpfire.pem;
    ssl_certificate_key /etc/ssl/private/dumpfire.key;

    # Shared by every location below.
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;

    # SSE support — disable buffering of what DumpFire answers
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;

    # Everything else. No client_max_body_size here: nginx's own default, 1m,
    # is more than the 512 KB DumpFire accepts on these, so it is DumpFire
    # that answers a body that is too large, and says the limit.
    location / {
        proxy_pass http://localhost:3000;
    }

    # Import Backup: a whole database. As much as the server itself accepts
    # (BODY_SIZE_LIMIT, 512M in the image).
    location = /api/admin/import {
        client_max_body_size 512m;
        proxy_pass http://localhost:3000;
    }

    # An attachment: a file of up to 25 MB, and the form it is sent in.
    location ~ ^/api/cards/[0-9]+/attachments$ {
        client_max_body_size 26m;
        proxy_pass http://localhost:3000;
    }
}
```

> ⚠️ **SSE requires `proxy_buffering off`** — without this, real-time board updates will not work.

> ⚠️ **Without the two `client_max_body_size` lines, nginx refuses any upload over 1 MB itself**, with a page of its own that never reaches DumpFire. The import then says the backup "was refused before it reached DumpFire, probably a size limit at the proxy in front of it (HTTP 413)", and so does an attachment. Before the page could tell the difference it said "Invalid backup file".

Leave `proxy_request_buffering` as it is, which is on. nginx then reads the whole upload before it passes it on, with its length in `Content-Length`, and DumpFire refuses one that declares more than its route accepts before reading any of it. Switched off, nginx passes an upload on in chunks as it arrives, which DumpFire also accepts: it counts such a body as it reads it, and refuses it once it passes the limit (see [Upload Size Limits](#upload-size-limits)). nginx keeps an upload of that size in a temporary file while it reads it, so its temp directory (`client_body_temp_path`) needs room for one backup.

### The Caller's Address Behind a Proxy

Behind the proxy, every request reaches DumpFire from the proxy, so unless it is told otherwise the server takes the proxy's address for every caller's. Two things are counted by address, and each then has one count for the whole installation:

- **Sign-in.** Ten attempts from one address in 15 minutes, less those at an account that then signed in from it (card 2226), and further attempts from it are refused for the rest of the 15 minutes. Behind an untold proxy, ten failed attempts by anyone refuse everybody's. A browser remembered for the account it signs in to (card 2194) is neither counted nor refused by this count, so behind an untold proxy one guesser no longer keeps everybody's usual browser out. The waits after five wrong passwords at one account (card 2177), and the rule that then lets browsers not remembered for it in one at a time (card 2194), are counted by account, not by address, so they work whatever address the server reads: behind an untold proxy they still slow a guesser at one account. That rule refuses a second sign-in at the same moment at an account under attack, from any address: see [If an Attack Keeps an Owner Out](#if-an-attack-keeps-an-owner-out). What the proxy changes is the per-address count, which is then one count for everyone. See [Guessing a Password at Sign-in](authentication-security.md#guessing-a-password-at-sign-in).
- **The documented API without a key.** A request to `/api/v1/` with no key DumpFire accepts, a missing header included, is counted against its address, 60 a minute (see [API Rate Limiting](#api-rate-limiting)). Behind an untold proxy, a key that is mistyped may be answered `429` while somebody else is guessing. A valid key is never held up by it: its requests are counted against the key.

The public request form is counted by address too, and so is each of these counted by the address's key rather than the address as received (card 2195): an IPv6 address by its /64 network, so that everyone on one IPv6 network shares one count, as an office behind one IPv4 address does; an IPv4 address written as IPv6 (`::ffff:198.51.100.7`) as the IPv4 address; and with no port, where a proxy writes one into its header (`198.51.100.7:51234`, `[2001:db8::1]:443`), since every connection has a port of its own. Behind an untold proxy every caller has the proxy's one address, and none of that changes anything. IPv6 reaches the counts only through `ADDRESS_HEADER`, as behind Cloudflare, which serves IPv6 by default. The log keeps the address as received; sign-in's refusal line adds the key where it differs, `Rate limit hit for IP 2001:db8:1:2::9, counted as 2001:db8:1:2::/64 (login attempts)`. See [How an Address Is Counted](authentication-security.md#how-an-address-is-counted).

The system log's `ip` column is the proxy's as well. Tell the server where the proxy writes the caller's address, with the header the nginx block above sets:

```bash
docker run -d \
  --name dumpfire \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v dumpfire-data:/app/data \
  -e DB_PATH=/app/data/dumpfire.db \
  -e ORIGIN=https://dumpfire.example.com \
  -e ADDRESS_HEADER=X-Forwarded-For \
  -e XFF_DEPTH=1 \
  dumpfire:latest
```

- **`XFF_DEPTH` is the number of proxies in front of the server.** nginx appends the address it was reached from to `X-Forwarded-For`, so with one proxy the caller is the last entry. A caller can write anything they like at the start of the header, which is why the address is read from the end. With a second proxy in front of nginx (a CDN, a load balancer), it is `2`.
- **The image does not set either.** With `ADDRESS_HEADER` set and no proxy in front, the header is absent from every request, and the server cannot read any caller's address. A request that reaches the container's port past the proxy is the same, which is why the port above is published on `127.0.0.1` only.
- **What DumpFire does without an address.** It asks for it guarded, everywhere it asks: a request whose address cannot be read is answered and logged without one, and every count by address, the sign-in form's, the public request form's and the documented API's, counts it as `unknown`, with every other caller whose address cannot be read. So with `ADDRESS_HEADER` set and no proxy in front, everybody shares one count, as behind an untold proxy. The sign-in form and the public request form answered `500` to such a request until 2026-10-14.

### Security Headers From the Proxy

DumpFire sets five security headers on every answer it gives (see [Security Headers](#security-headers)). Some answers are made where DumpFire's gate never sees them, and carry none of the five unless the proxy adds them:

- every static file of the built server (`/_app/immutable/...`, `/_app/version.json`, which every open page asks for once a minute, `robots.txt`), which the server sends before the gate is called;
- the `403` for a form posted from another site, which SvelteKit sends before the gate is called;
- the redirect that adds or removes a trailing slash;
- the `404` for any other path that begins `/_app`, but a call to a remote function, `/_app/remote/...`, which DumpFire's gate answers `404` itself, whatever path the call's `x-sveltekit-pathname` header names (there are no remote functions), but one that cannot be decoded, which is the gate's `400` `Malformed URI`, as SvelteKit 2.60 also answered it;
- the `500` for a fault in the gate itself.

None of these is a page anybody uses, so the one that matters is `X-Content-Type-Options`. To add a header only where DumpFire has not, so that no answer carries it twice, map the upstream's header to an empty value, which nginx does not send:

```nginx
# In the http block, beside the server block above.
map $upstream_http_x_content_type_options $dumpfire_nosniff {
    ""      "nosniff";
    default "";
}

# In the server block.
add_header X-Content-Type-Options $dumpfire_nosniff always;
```

Do not add `X-Frame-Options` from the proxy for every answer: DumpFire leaves it off the public request form's three pages on purpose, so that the form can be embedded in another site's page. A location that sets an `add_header` of its own stops inheriting the server block's, so set it in each such location as well.

**Do not add a `Content-Security-Policy` at the proxy.** Every page carries DumpFire's own, with a new nonce for its scripts each time (see [The Content-Security-Policy](authentication-security.md#the-content-security-policy)). A browser enforces a second policy beside it, and one written at the proxy holds no page's nonce, so it stops every page's scripts. For the same reason a script that a proxy or front **puts into pages** (Cloudflare's Rocket Loader, its automatic Web Analytics beacon, any "optimisation" that rewrites HTML) is refused by the policy. Command 3 under [The Update That Brings the Content-Security-Policy](#the-update-that-brings-the-content-security-policy) shows whether a policy is there, and a count above `0` on its second line whether such a feature may be: read the browser's console in the report-only trial, and turn the feature off only if a report names it.

## Upload Size Limits

A request's body passes three limits on its way in, and each answers differently when it is too large:

```mermaid
flowchart LR
    Browser["Browser or API caller"] -->|"upload"| Proxy["nginx:\nclient_max_body_size"]
    Proxy -->|"too large: 413,\nnginx's own HTML page"| Browser
    Proxy -->|"passed on whole, with Content-Length,\nor in chunks as it arrives"| Gate["DumpFire's gate:\nthe limit of the route"]
    Gate -->|"declared too large: 413 JSON\nwith the limit, none of it read.\nNo length, read past the limit:\n413 JSON with the limit"| Browser
    Gate --> Adapter["The server:\nBODY_SIZE_LIMIT"]
    Adapter -->|"runs past the length\nit declared: 413 JSON"| Browser
    Adapter --> Handler["The route"]
```

| The route | The most its body may be | Where that is set |
|-----------|--------------------------|-------------------|
| Every route, a page's form included | 512 KB | `src/lib/server/body-limits.ts` |
| `POST /api/cards/[id]/attachments`, for a caller who is signed in | 26 MB: the handler accepts a file of up to 25 MB | The same file |
| `POST /api/admin/import`, for the superadmin (anybody else signed in is held to 512 KB, and refused by the handler before it reads a byte) | All the server accepts: `BODY_SIZE_LIMIT` | The `Dockerfile` sets `512M`; override it with `-e BODY_SIZE_LIMIT=...` |

A request that declares its length in `Content-Length` is held to the limit on that, before its body is read, so an upload that says it is too large is refused without any of it being read. One that declares no length, sent in chunks by its client or by a proxy that passes a body on that way (`cloudflared` does unless it is told not to: see below), is counted as it is read and refused once it passes the limit: the server reads up to the limit, and no further, before it refuses it. Either way the server never reads more than the limit, but a refusal of a body sent in chunks is not free. The server on its own holds a body with no length to `BODY_SIZE_LIMIT` alone, the whole server's limit (it held one to no limit at all before adapter-node 5.5.5), which is why the gate counts it against its route's. A chunked body that passes `BODY_SIZE_LIMIT` itself is refused by the server first, before the gate's count sees the bytes that pass it, and is answered `413` `{"message":"Payload Too Large"}`, without `limitBytes`: that is the import, whose limit is `BODY_SIZE_LIMIT`. Every route with a smaller limit still gets the gate's `413` with `limitBytes`.

**Behind Cloudflare Tunnel, for large uploads.** `cloudflared` passes a body on in chunks unless its `originRequest` settings say `disableChunkedEncoding: true`. Uploads work either way. With it, the length the browser declared reaches DumpFire, and a backup or an attachment that is too large is refused before any of it crosses from the tunnel to the server, rather than after the first 512 KB or 26 MB of it has. It is a saving, not a requirement. Cloudflare has a limit of its own on an upload: see [How Large an Import Can Be](#how-large-an-import-can-be).

No route is given more than `BODY_SIZE_LIMIT`. A server started without the image's setting, with `node build` and no variable, accepts 512 KB everywhere: an attachment over that is refused there, and so is an import.

`BODY_SIZE_LIMIT` takes a number of bytes, or a number followed by `K`, `M` or `G`. **`512MB` is not accepted**: the server does not start, and logs `Invalid BODY_SIZE_LIMIT: '512MB'. Please provide a numeric value.`

After a deploy, check that the container has the setting:

```bash
docker exec <container> printenv BODY_SIZE_LIMIT
```

It prints `512M`. Nothing printed means the image was built from a `Dockerfile` without the line, and every upload over 512 KB will be refused.

### How Large an Import Can Be

The limit is not the only ceiling. An import does this, in order:

1. Reads the whole upload into memory.
2. Writes it to `.restore-temp.db` in the server's working directory, and opens that.
3. Writes a safety copy of the running database, every table as one JSON text, to `.pre-restore-safety.json` in the same directory. It leaves out the `known_browser_secret` row of `settings`, the key remembered browsers are signed with, which no backup holds either.
4. Replaces the rows.

So the server needs memory for the whole backup and, at the same moment, for the running database as JSON, which is larger than the database's own file because every row repeats its column names. That JSON is one piece of text, and Node 22 cannot make one longer than 536,870,888 characters, about 512 MB: a running database whose rows come to more than that as JSON cannot be imported over. The import then fails with "Restore failed: Invalid string length" and nothing is changed. That, and the memory the container is allowed, are the practical ceiling, and both are reached well before a backup of 512 MB is. Neither has been measured on a large database: try an import of production's size on an instance that is not production before it is needed.

Two limits outside DumpFire end an upload before it is read:

- **The server's own time limit for a request.** Node gives a request five minutes, its `server.requestTimeout` default of 300 seconds, to arrive in full, and the image does not change it. An upload that takes longer is cut off and the import never starts. Behind nginx, which reads the whole upload before it passes it on, the server is handed it in a moment, whatever the caller's connection. With no proxy, or behind one that passes the upload on as it arrives (Cloudflare Tunnel, Caddy, nginx with `proxy_request_buffering off`), the server receives it at the caller's speed, and an import that takes more than five minutes to upload cannot be done that way: upload it from somewhere closer to the server.
- **Cloudflare's own limit on a request's body.** Behind Cloudflare, a Cloudflare Tunnel included, Cloudflare refuses a request whose body is over its plan's limit before it reaches the server: 100 MB on the Free and Pro plans. A backup larger than that cannot be imported through it; import it through an address that does not pass through Cloudflare.

Both files are written to the working directory, which in the image is `/app`: **inside the container and off the volume**. They need that much free space in the container's own layer, and they go when the container is recreated. `.restore-temp.db` is deleted when the import ends. `.pre-restore-safety.json` is not: it stays until the next import replaces it, and it holds everything the database held, password hashes and live sessions included, but for the key remembered browsers are signed with. Once the import is known to be good, remove it:

```bash
docker exec <container> rm -f /app/.pre-restore-safety.json
```

## Backup Destinations

```mermaid
flowchart LR
    DumpFire["🔥 DumpFire"] -->|"SFTP"| SFTP["SFTP Server"]
    DumpFire -->|"AWS SDK"| S3["Amazon S3"]
    DumpFire -->|"OAuth"| GDrive["Google Drive"]
    DumpFire -->|"Graph API"| OneDrive["OneDrive"]
```

The scheduler checks once a minute whether a backup is due. Each backup:
1. Writes a complete copy of the database to a temporary file beside it with `VACUUM INTO`, which includes changes still in the write-ahead log. It then opens the copy with no journal, deletes every session, every unused invite, the key remembered browsers are signed with and the key the request form signs with from it, sets every request's link to `NULL`, masks every invite's token, any request link's token and the name typed at an old failed sign-in in its system log, deletes the mail password and the key backups are sealed with, empties every destination's secret fields and every webhook's secret, switching each such webhook off (card 2169), seals it (an HMAC of every row, written into it as `backup_seal`), and writes it out again with a second `VACUUM INTO` to a second temporary file, so that nothing of what was deleted is left in the file. It reads that second file and deletes both. The running database is not touched: nobody is signed out by a backup, and its own log is as it was; the first backup writes the seal's key into it (`backup_seal_key`), and none after. Every step of this is synchronous, so **the server answers no request from the start of the first `VACUUM INTO` until the second file has been read**: both copies, the masking, the deletes and the read, and not only the first copy. "Export Backup" stops it the same way. See "How long the server stops answering", below. Both temporary files are beside the database, on the volume, so it needs room for two copies while a backup is made, and none for a journal.
2. Uploads the copy as it is, not compressed, to each configured destination as `dumpfire-backup-<UTC date and time>.db`
3. Records the result for each destination in the `backup_log` table, which keeps the last 10 entries
4. After a successful upload, deletes the oldest backups at that destination beyond the retention count (a retention of 0 keeps them all). On Google Drive only the files the connected account may delete or trash are counted, and one it may not is left with one `WARN` line a run: see [Configuring Backups](admin-guide.md#configuring-backups)

A failed upload is not retried. It is logged at `ERROR`, recorded in `backup_log` with the error, and emailed to the alert address if failure alerts are switched on and SMTP is configured. The destination is tried again at the next scheduled backup.

**A destination whose credentials are not entered is not tried** (card 2169): an S3 destination with no secret access key, a Google Drive one with no client secret or refresh token (OAuth) or whose service account JSON holds no private key, a OneDrive one with no client secret. It is asked before the copy is made, and such a destination fails at once, recorded, logged and mailed as any failure is, with "This destination's credentials are not entered: a backup does not hold them, so they are entered again after a restore. Enter them in Admin, Scheduled Backups." (a Google Drive OAuth one: "… enter its client secret and connect it again."). A run in which no destination can be tried makes no copy at all, so the server does not stop answering for a copy nobody takes. An SFTP destination with neither a password nor a key is tried as before, once its host key is confirmed: a server that allows `none` authentication accepts it. So after a restore onto another server, such a destination, its key confirmed again, is tried against the real host at every scheduled run, and its failed logins may trip a lockout there: enter its credentials, or remove it.

**An SFTP destination whose host key is not confirmed is not tried either** (card 2250), asked at the same point, with "SFTP host key not confirmed: nothing was sent to this destination. In Admin, Scheduled Backups, press Test on it and confirm the key it shows." Every connect to an SFTP destination with a confirmed key pins the key's type (`algorithms.serverHostKey`) and checks the SHA-256 fingerprint of the key the server presents (`hostVerifier`), inside the key exchange and before a password or private key is used: a key that does not match, a server that no longer offers one of the confirmed type, or one that shows the confirmed key and cannot sign with it, fails the upload, the listing or the delete with nothing sent. A restore never takes a host key from a backup. See [An SFTP Destination's Host Key, Confirmed and Checked at Every Connect](#an-sftp-destinations-host-key-confirmed-and-checked-at-every-connect).

A backup file is a whole database: its data, its structure and its own record of applied migrations, with what would open something taken out. It holds no session, and no invite that has not been used: either would sign in whoever read the file. Its system log names no invite's token either: the server wrote an invite's address into the log with the token in it until 2026-10-14, and a backup masks those lines. The server masks the same lines in its own log once at every start, so `GET /api/logs` shows none of those tokens either from the first start on this version. Every user is in it with their password hash and email, and every webhook with its address, so it is still a file to keep where few can read it: a Slack or Teams incoming webhook's address is all anyone needs to post to that channel, so if a copy may have been read, make a new one at its service. The file "Export Backup" downloads is made the same way and holds the same.

**No secret is in a backup** (card 2169): not the mail password, not a destination's credentials (an SFTP password or private key, an S3 secret access key, a Google Drive client secret and refresh token or a service account's private key, a OneDrive client secret), not a webhook's signing secret. Each destination's other fields stay, and a webhook that had a secret is switched off in the copy and listed in `webhook_secrets_left_out`, so that a file put in place by hand sends nothing unsigned. An Import Backup fills each gap from this server where it is for the same account, in every field that is not secret, and only into a backup this server made and nobody has changed since (its seal, made again with this server's key), and its result lists any to enter again; a file put in place by hand comes up with none of them, and every start writes one `[WARN] [STARTUP]` line naming what is still to enter. See [What a Backup Holds, and What a Restore Brings In](authentication-security.md#what-a-backup-holds-and-what-a-restore-brings-in).

**So a backup alone no longer rebuilds a lost server.** On a server that still runs, restore with Import Backup, which keeps this server's secrets; put a file in place by hand only when it cannot start. A server rebuilt from nothing needs every secret entered again, so keep the mail password and each destination's credentials outside DumpFire (a password manager), and know who holds each webhook's secret. An S3 secret key cannot be read again from AWS (a new one is made); a Google Drive OAuth destination needs its client secret from the Google Cloud console, then Connect; a webhook's secret is known only at its receiver.

A backup opens no request's thread either (card 2158): every request is in it with its link (`task_requests.access_token`) empty, and the key the public request form signs its tokens with (`request_form_secret` in `settings`) is not in it. A restore gives every request a new link, whatever the backup holds, and its answer says how many it replaced; it never brings the form's key in, and the restored server makes a new one. The key remembered browsers are signed with (`known_browser_secret` in `settings`, card 2194) is taken out of every copy and never restored, so a restore forgets every remembered browser and the restored server makes a new key. A backup's system log holds no name typed at a failed sign-in at a name that was no account either: those lines are rewritten in the copy, and in the running log at every start (card 2193).

**What clearing the copy costs.** The copy used to be vacuumed in place, which needs a rollback journal on the volume as large as the copy. Writing it out again with `VACUUM INTO` needs no journal, and is quicker. Measured once by the reviewer, on a 154 MB copy: 2.7 s for the vacuum in place, 1.3 s for `VACUUM INTO`, with no planted session id or token left and the integrity check passing. Measured again for this change, on a 196 MB database made up for the purpose (never a real one) on a Windows development machine, six runs of each: the vacuum in place took 1.7 to 3.1 s, `VACUUM INTO` 0.5 to 1.3 s, and the first copy 0.7 to 1.5 s. Neither has been measured on the production server; expect the figures to grow with the database.

**How long the server stops answering.** The server waits for the whole of a backup, not only for the first copy, and that whole has never been measured. Added together from the separate figures above, the two `VACUUM INTO`s alone came to about 1.2 to 2.8 s on the 196 MB made-up database on the development machine (0.7 to 1.5 s for the first copy, 0.5 to 1.3 s for the second); the masking of the log, the deletes and the reading of the file come on top of that, unmeasured. The seal (card 2169) reads every row of the copy once more: measured on made-up copies on a development machine, 0.2 s for 59 MB and 115,000 rows, 0.56 s for 177 MB and 345,000; an Import Backup spends as long again making it afresh from the file it is given. It is an estimate from parts, on a machine that is not the server. Expect it to be longer on a larger database or a slower disk, and schedule backups for an hour when few people use DumpFire.

Backups made before this version do hold the sessions of whoever was signed in when they were made, and a session goes on being good for as long as it is used. Restoring one no longer brings them back: a restore brings in no session whatever the backup holds. Those made before card 2158 hold every request's link as it was mailed, which migration 0055 replaces once and every restore replaces again. Those made before card 2169 hold the mail password, every destination's credentials and every webhook's secret, and carry no seal, so Import Backup of one keeps nothing from this server (it needs nothing kept); nothing can take the secrets out of a copy already made, and they go as each destination's retention removes them. If one of them may have been read by somebody who should not have, change the mail password and each destination's credentials at their services and enter them again, and set new webhook secrets with their receivers. The copies themselves, at a destination or downloaded, are unchanged: treat them as you would a password file, and delete the ones that are not needed.

**What the admin page is told of the secrets, and when a saved one is used** (cards 2187 and 2190). `GET /api/admin/backup` answers every secret field masked, `••••••••`, whatever the destination's type: an SFTP password and private key, an S3 secret access key, a client secret, a Google Drive refresh token and a service account's private key (a service account JSON that cannot be read as an object is masked whole). A save or a test that sends a secret masked uses the saved one only from the one saved destination that is the same in type, name and every setting that is not secret; otherwise it is refused `400`, naming what to type again, with nothing written. See [Configuring Backups](admin-guide.md#configuring-backups).

**Google Drive with OAuth** (card 2188). Connect asks Google for `https://www.googleapis.com/auth/drive.file`, the files DumpFire makes, and records the scope Google granted as `grantedScope` in the destination. With the Folder ID empty it makes a folder, "DumpFire backups (made YYYY-MM-DD)", in the account's My Drive and saves its id; with one set it fetches it and refuses the Connect, saving nothing, when Google does not let it reach it. Connections made before this change asked for the whole of Drive and keep it until they are narrowed by hand, removing DumpFire's access in the Google account first: see [Configuring Backups](admin-guide.md#configuring-backups). A token refreshes with the scopes it was granted, so the deploy stops no Drive backup.

**A Connect is finished only by the session that started it** (card 2251): the consent address carries a random `state` and a PKCE challenge, and the whole address Google's page leads to must be pasted back from the same session, within ten minutes, once. See [A Google Drive Connect Finished Only by the Session That Started It](#a-google-drive-connect-finished-only-by-the-session-that-started-it).

Backup destinations, the schedule and "Run Now" are the superadmin's: see [The Superadmin](#the-superadmin). See [Restoring from Backup](admin-guide.md#restoring-from-backup) for the two ways to put one back.

A backup file holds no attachment file. The uploads folder is backed up separately, by you: see [Attachment Files](#attachment-files).

## Security Headers

Set by the gate on every answer it gives, to anybody: pages, the internal and the
documented API, the gate's own refusals and its redirects. A header the answer already has
is left as it is.

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY`, except on `/request`, `/request/[id]/confirm` and `/request/[id]/reply` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `X-XSS-Protection` | `0`: switches off the filter old browsers ran over a page, which could itself be used to make a page leak |
| `Content-Security-Policy` | On pages only, set by SvelteKit with a new nonce on every page; `Content-Security-Policy-Report-Only` instead while `CSP_MODE=report-only`. No API answer, redirect or gate refusal carries one, and an attachment keeps its own `sandbox` |

The public request form and the two pages its mails link to carry no `X-Frame-Options`, so
that the form can be embedded in another site's page; every other page refuses to be
framed. What the gate never sees is the proxy's to head: see
[Security Headers From the Proxy](#security-headers-from-the-proxy). See
[Security Headers](authentication-security.md#security-headers).

## API Rate Limiting

The external API `/api/v1/*` is rate-limited, in memory, per process:
- **60 requests per minute per API key**, counted against the key once it is checked. A key
  over its limit is answered `429` and its `last_used_at` is not touched.
- **60 requests per minute per address** for requests with no key DumpFire accepts, a
  missing `Authorization` header included, in a count of their own: they never spend a real
  key's allowance. An IPv6 address is counted by its /64 network, an IPv4 address written as
  IPv6 as the IPv4 address, and a port is taken off (card 2195). Behind a proxy, set `ADDRESS_HEADER` or every caller has the proxy's
  address: see [The Caller's Address Behind a Proxy](#the-callers-address-behind-a-proxy).
- Returns `429 Too Many Requests` with a `Retry-After` header when exceeded.
- `GET /api/v1/openapi.json` needs no key and is not counted.
