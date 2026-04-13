# TODO

- [ ] Add extension icons (16/48/128px) — currently referenced in
      `manifest.json` but the files don't exist
- [ ] Add e2e tests using the existing Playwright fixture
      (`tests/fixtures/extension.ts`)
- [ ] Add an options page with an enable/disable toggle
- [ ] Test with the real extension loaded (all testing so far was via
      Playwright `page.evaluate` injection, not with the actual extension)
