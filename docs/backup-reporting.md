---
title: "Backup & Reporting System"
category: Admin & Tools
version: 1.0
status: As-Built
date: 2026-04-14
tags:
  - backup
  - reports
  - pdf
  - scheduling
  - sftp
  - s3
  - google-drive
  - onedrive
description: "Scheduled backup system with multi-destination support and PDF report generation engine with email delivery"
---

# Backup & Reporting System

DumpFire includes two scheduled systems: automated database backups to multiple cloud/remote destinations, and PDF report generation with email delivery.

## Backup System

### Backup Architecture

```mermaid
flowchart TD
    Scheduler["Backup Scheduler\n60s check interval"]
    Scheduler --> DueCheck{"Backup due?"}
    DueCheck -->|"No"| Wait["Wait 60s"]
    DueCheck -->|"Yes"| Generate["VACUUM INTO\ntemp .db file"]
    Generate --> ReadFile["Read backup file\ninto Buffer"]
    ReadFile --> Upload["Upload to each\nconfigured destination"]

    Upload --> SFTP["SFTP Server\nssh2-sftp-client"]
    Upload --> S3["Amazon S3\nAWS SDK"]
    Upload --> GDrive["Google Drive\ngoogleapis"]
    Upload --> OneDrive["OneDrive\nMicrosoft Graph"]

    SFTP --> LogResult["Log to backup_log"]
    S3 --> LogResult
    GDrive --> LogResult
    OneDrive --> LogResult

    LogResult --> Retention["Retention cleanup\nDelete oldest files"]
    LogResult -->|"Failed"| NotifyEmail["Send failure email\nif configured"]
```

### Schedule Options

| Schedule | Mechanism | Description |
|----------|-----------|-------------|
| `disabled` | — | No automatic backups |
| `hourly` | Interval | Every 60 minutes since last backup |
| `every6h` | Interval | Every 6 hours since last backup |
| `every12h` | Interval | Every 12 hours since last backup |
| `daily` | Time-based | Once per day at configured time |
| `weekly` | Time-based | Once per week on configured day and time |

### Backup Configuration

Stored as JSON in the `settings` table under key `backup_config`:

```json
{
  "schedule": "daily",
  "scheduleTime": "02:00",
  "scheduleDay": 0,
  "retention": 7,
  "destinations": [],
  "notifyOnFailure": true,
  "notifyEmail": "admin@example.com"
}
```

### Backup Data Generation

Uses SQLite's `VACUUM INTO` command to create a self-contained snapshot:

```mermaid
sequenceDiagram
    participant Scheduler
    participant SQLite
    participant FS as Filesystem

    Scheduler->>FS: Remove stale temp file
    Scheduler->>SQLite: VACUUM INTO 'path.backup-temp'
    Note over SQLite: Creates complete copy\nincluding WAL data
    Scheduler->>FS: readFileSync temp file
    FS-->>Scheduler: Buffer
    Scheduler->>FS: Delete temp file
    Scheduler-->>Scheduler: Return Buffer
```

This approach ensures the backup includes all WAL data — a raw file copy would miss unflushed writes.

### Destination Types

```mermaid
flowchart LR
    subgraph Destinations
        SFTP["SFTP\nssh2-sftp-client"]
        S3["Amazon S3\nAWS SDK v3"]
        GDrive["Google Drive\ngoogleapis OAuth"]
        OneDrive["OneDrive\nMicrosoft Graph"]
    end

    subgraph Operations
        Upload["upload"]
        List["list"]
        Delete["delete"]
    end

    Destinations --- Operations
```

Each destination implements three operations:
- **upload** — Push a backup buffer with a timestamped filename
- **list** — List existing backups for retention cleanup
- **delete** — Remove old backups beyond retention limit

### Retention Cleanup

After each successful upload, the system:
1. Lists all backup files at the destination
2. Sorts oldest-first
3. Deletes files exceeding the configured retention count

### Failure Notifications

If `notifyOnFailure` is enabled and SMTP is configured, a styled HTML email is sent to the configured address with the error details.

---

## Report System

### Report Architecture

```mermaid
flowchart TD
    subgraph Triggers
        Manual["Manual generation\nReports page"]
        Scheduled["Report Scheduler\n60s check interval"]
    end

    subgraph Generation
        ScopeSelect["Select scope\nBoard / Category / All"]
        ScopeSelect --> DataCollect["Collect cards, assignees,\nsubtasks, activity"]
        DataCollect --> BuildReport["Build ReportData object"]
        BuildReport --> RenderPDF["Render PDF\nPDFKit"]
    end

    subgraph Delivery
        Download["Direct download\nbrowser response"]
        EmailDelivery["Email with PDF\nattachment"]
    end

    Manual --> ScopeSelect
    Scheduled --> ScopeSelect
    RenderPDF --> Download
    RenderPDF --> EmailDelivery
```

### Report Scopes

| Scope | Description | Data Included |
|-------|-------------|---------------|
| `board` | Single board | All cards in that board for the period |
| `category` | Board category | All boards in a category, aggregated |
| `all` | All boards | Every board across the system |

### Report Data Structure

```mermaid
flowchart TD
    ReportData["ReportData"]
    ReportData --> Summary["Summary\ntotal, completed, created\noutstanding, overdue"]
    ReportData --> Priority["Priority Breakdown\ncritical, high, medium, low"]
    ReportData --> Assignees["Assignee Stats\nper-user completed + outstanding"]
    ReportData --> Outstanding["Outstanding Tasks\ngrouped by board + category"]
    ReportData --> Completed["Completed Tasks\ngrouped by board + category"]

    Outstanding --> TaskDetail["TaskDetail\ntitle, priority, due date\nassignees, subtasks\ndescription, business value"]
    Completed --> TaskDetail
```

### PDF Generation

PDFs are rendered server-side using PDFKit with a professional layout:

- **Header** — DumpFire branding, report title, date range
- **Executive Summary** — Key metrics in stat cards
- **Priority Breakdown** — Visual bar chart
- **Assignee Performance** — Table of completions per user
- **Outstanding Tasks** — Grouped by board with full detail
- **Completed Tasks** — Recent completions with timestamps

### Report Scheduling

Configured per-user via the Reports page:

| Field | Type | Description |
|-------|------|-------------|
| `scope` | board/category/all | What to report on |
| `scopeId` | number | Board or category ID |
| `frequency` | weekly/monthly | How often |
| `dayOfWeek` | 0-6 | Day for weekly reports |
| `dayOfMonth` | 1-31 | Day for monthly reports |
| `timeOfDay` | HH:MM | When to generate |
| `recipients` | comma-separated emails | Where to send |
| `periodDays` | number | Lookback period in days |
| `enabled` | boolean | Active toggle |

### Schedule Execution

```mermaid
sequenceDiagram
    participant Timer as Scheduler Timer
    participant DB
    participant Engine as Report Engine
    participant SMTP

    Timer->>DB: Query due schedules\nwhere nextRunAt <= now
    DB-->>Timer: Matching schedules
    
    loop Each schedule
        Timer->>Engine: generateReport by scope
        Engine->>DB: Query boards, cards, assignees
        DB-->>Engine: Raw data
        Engine->>Engine: Build ReportData
        Engine->>Engine: Render PDF via PDFKit
        Engine-->>Timer: PDF Buffer
        Timer->>SMTP: Send to each recipient\nwith PDF attachment
        Timer->>DB: Update lastRunAt, nextRunAt
    end
```

### Card Reports

Individual card reports can be generated for completion notifications. These include:
- Card title, priority, and business value
- Description rendered as text
- Subtask completion status
- Assignee list
- Activity timeline

## Key Implementation Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/server/backup.ts` | 374 | Backup scheduling, data generation, upload orchestration |
| `src/lib/server/backup-destinations.ts` | ~400 | SFTP, S3, Google Drive, OneDrive destination implementations |
| `src/lib/server/reports.ts` | 1124 | Report data collection, PDF rendering, schedule management |
| `src/lib/server/snapshots.ts` | ~80 | Daily card count snapshots for CFD/burndown charts |
