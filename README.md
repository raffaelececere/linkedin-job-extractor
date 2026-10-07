# LinkedIn Job Extractor

A lightweight Tampermonkey userscript for exporting LinkedIn Jobs listings to structured TXT and JSON files.

It works directly inside the LinkedIn Jobs interface, collecting job metadata and full descriptions without opening popup windows or relying on external services.

![LinkedIn Job Extractor](docs/linkedin-job-extractor.png)

## Features

- Full job descriptions
- Title, company and location/work mode
- Salary and compensation extraction when available
- Multi-page extraction
- Duplicate detection by Job ID
- TXT and JSON export
- Progress bar, elapsed time and estimated remaining time
- Persistent state while moving between result pages
- Partial-result recovery after an interrupted run
- Downloadable debug log for the latest extraction
- Compact draggable interface

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the [LinkedIn Job Extractor userscript](https://raw.githubusercontent.com/raffaelececere/linkedin-job-extractor/main/linkedin-job-extractor.user.js).
3. Confirm the installation in Tampermonkey.
4. Open LinkedIn Jobs.

No build step or additional dependency is required.

## Usage

Open a LinkedIn Jobs search and choose how many result pages you want to process.

Press **START EXTRACTION** and leave the LinkedIn Jobs tab open while the script works through the available listings.

When the extraction is complete, choose the export format:

- `TXT`
- `JSON`
- `TXT + JSON`

Then press **SAVE RESULTS**.

The panel can be minimized with the `−` button and moved anywhere on the page while the extraction is running.

## How it works

LinkedIn Job Extractor scans the result cards currently available in LinkedIn Jobs and processes them sequentially.

For each listing, it opens the job in the existing LinkedIn interface, waits for the corresponding details pane, expands the description when required, validates the selected job and extracts the available metadata.

The state of the current run is preserved between result pages, so multi-page searches can continue after LinkedIn navigates to the next page.

Processing is intentionally sequential because LinkedIn uses a single mutable job-details pane. Running multiple job activations in parallel could associate metadata from one listing with the description of another.

## Exported data

Each exported job can include:

- Job title
- Company
- Location and work mode
- Salary or compensation information
- LinkedIn Job ID
- Canonical job URL
- Full description
- Original card text
- Description source

The JSON export also includes basic generator metadata and any listings that were skipped during extraction.

## Reliability

LinkedIn is a dynamic single-page application and its DOM can change over time.

The extractor uses multiple selectors and structural fallbacks for important elements, verifies the selected job before reading the details pane and uses bounded waits instead of fixed delays where possible.

Repeated extraction failures stop the run rather than creating an uncontrolled retry loop. Results already collected remain available for export.

## Debugging

The interface includes a **DOWNLOAD DEBUG** button.

The debug log only contains events from the latest extraction run and is intended to help diagnose DOM changes, missing fields or failed listings.

Before sharing a debug file publicly, review its contents because it can include job titles, companies, Job IDs and browser information.

## Privacy

LinkedIn Job Extractor runs locally in the browser.

It does not contain credentials, authentication tokens or API keys, and it does not send extracted job data to an external service.

The script does not use `eval`, remote code loading or direct background scraping requests.

## Compatibility

The userscript targets:

```text
https://www.linkedin.com/jobs/*
```

It is designed for Tampermonkey-compatible desktop browsers.

Because LinkedIn can change its interface without notice, future DOM changes may require selector updates.

## Project structure

The project intentionally ships as a single userscript:

```text
linkedin-job-extractor/
├── linkedin-job-extractor.user.js
├── README.md
└── docs/
    └── linkedin-job-extractor.png
```

There is no bundler or runtime dependency. The installed file is the same source file stored in this repository.

## Disclaimer

LinkedIn Job Extractor is an independent, unofficial project and is not affiliated with, endorsed by or sponsored by LinkedIn.

Users are responsible for using the script in accordance with applicable terms, policies and local requirements.


## Author

Raffaele Marco Cecere

GitHub: [@raffaelececere](https://github.com/raffaelececere)
