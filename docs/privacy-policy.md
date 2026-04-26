# Privacy Policy

**Google Docs Range Diffs** does not collect, store, or transmit any data.

## Data handling

- The extension does not send any data to any server.
- The extension does not use analytics, tracking, or telemetry.
- The extension does not retain any user content. All processing
  happens locally in the browser where the extension is running.

## Permissions

The extension declares the following permissions, each used solely to
provide its in-page features on Google Docs:

- **`scripting`** — required to inject extension behavior into Google Docs.
- **`host_permissions: https://docs.google.com/*`** — This is the only
  site where the extension runs.

## What the extension does on Google Docs pages

- Modifies the Version history panel to enhance version selection UI.
- Intercepts and rewrites `showrevision` request parameters, causing Google
  Docs to fetch the user-selected version range.
- Does not read or modify the text or content of your documents.

## Contact

Questions or concerns: file an issue at
<https://github.com/jshute96/GoogleDocsRangeDiffs/issues>.
