# LinkedIn Job Extractor

A lightweight Tampermonkey userscript that extracts job listings from LinkedIn Jobs and exports structured TXT and JSON files.

The project intentionally ships as **one installable `.user.js` file**. There is no build step, no popup worker, no direct scraping request layer, and no external runtime dependency.

> Status: `1.0.0` is the first stable release.

## What it does

- Collects the job cards currently exposed by LinkedIn Jobs.
- Activates each card inside the existing LinkedIn SPA.
- Waits for the corresponding details pane instead of using arbitrary per-job delays.
- Expands truncated job descriptions before reading them.
- Preserves paragraph/list formatting in exported descriptions.
- Extracts title, company, location/work mode, salary/compensation when available, canonical job URL, and description.
- Persists progress across search-result pages.
- Exports TXT, JSON, and a diagnostic debug log.
- Stops after repeated pane failures instead of creating an uncontrolled retry cascade.

## Installation

1. Install Tampermonkey in your browser.
2. [Install LinkedIn Job Extractor](https://raw.githubusercontent.com/sbzzzzzzzzz/linkedin-job-extractor/main/linkedin-job-extractor.user.js)
3. Confirm the installation in Tampermonkey.
4. Open LinkedIn Jobs.
5. Choose the number of result pages and start the extraction.

Only the `.user.js` file is required by end users.

## Interface

The floating panel shows current-page progress, elapsed time, and an estimated remaining time based on the run's observed average processing time. The ETA is intentionally labeled as an estimate because LinkedIn may load individual job panes at different speeds.

The panel can also be minimized with the standard `−` control next to `×`. In compact mode it remains draggable and shows the current completion percentage; the compact/restored state and panel position are preserved across LinkedIn page navigation.

Results are not downloaded automatically. After a completed or interrupted run, the user can choose `TXT`, `JSON`, or `TXT + JSON` and use **Save Results**. The Stop control is enabled only while an extraction is running. Diagnostic history is reset when a new extraction starts, so the debug file contains only the latest run.

## Design

The extractor deliberately works through the normal LinkedIn Jobs interface.

```text
Search result cards
        ↓
Collect Job IDs + card metadata
        ↓
Activate one card
        ↓
Verify details-pane identity
        ↓
Expand description when required
        ↓
Normalize + validate extracted data
        ↓
Persist state
        ↓
Next card / next results page
        ↓
TXT + JSON + diagnostic log
```

Processing is serial by design. The job-details pane is a single mutable SPA surface; concurrent card activation would introduce race conditions and could associate one job's metadata with another job's description.

## Reliability strategy

The script uses multiple selectors for important DOM regions and falls back to structural heuristics where practical. It verifies pane identity using Job ID when available and title/company consistency as a fallback. Dynamic descriptions are expanded before extraction, with a bounded wait and one bounded card retry.

Repeated pane failures trigger an early stop. This is intentional graceful degradation: partial results are preserved instead of continuing through a broken UI state.

## Privacy and security

- No credentials, cookies, tokens, or secrets are embedded in the source.
- No `eval`, `new Function`, remote code loading, or direct background scraping requests are used.
- Diagnostic URLs are sanitized before logging; transient LinkedIn tracking parameters are not intentionally persisted in the debug log.
- Exported job URLs are canonical `/jobs/view/<id>/` URLs.
- HTML from structured job data is parsed in a detached document and converted to plain text.
- The script only exports information visible in the LinkedIn Jobs UI plus its own diagnostic metadata.

Review debug logs before sharing them publicly; they may still contain job titles, companies, Job IDs, browser information, and search-state diagnostics.

## Compatibility

The userscript targets:

```text
https://www.linkedin.com/jobs/*
```

LinkedIn is a frequently changing SPA. DOM changes can break selectors even when the JavaScript itself remains valid. Selector fallbacks reduce that risk but cannot eliminate it.

## Development principles

The repository keeps distribution intentionally simple: one userscript, readable source, no bundler required.

Inside that file, responsibilities remain separated into configuration, persistence/logging, UI, DOM discovery, parsing/normalization, extraction orchestration, pagination, and export/lifecycle code.

Before publishing a stable release:

```bash
node --check linkedin-job-extractor.user.js
```

Then run browser regression tests for:

- one results page;
- multiple results pages;
- long descriptions with “Show more” / localized equivalents;
- jobs with and without salary data;
- duplicate/similar job titles;
- an interrupted run followed by resume/reset.

## Project scope

This project is an unofficial browser automation utility and is not affiliated with or endorsed by LinkedIn. LinkedIn may change its interface at any time. Users are responsible for using the script in accordance with applicable terms, policies, and local requirements.

## License

Add an explicit open-source license before publishing the repository. MIT is a reasonable default for a small userscript if that matches the maintainer's intent.


## Repository

Source code and releases: https://github.com/sbzzzzzzzzz/linkedin-job-extractor
