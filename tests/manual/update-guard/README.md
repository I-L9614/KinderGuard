# Update-guard integration test (manual)

End-to-end check of the in-app update install guard with the REAL frontend,
the REAL backend (in-memory MongoDB), and a real Chromium, driven over the
Chrome DevTools Protocol. The Electron bridge is injected as a mock before the
page loads, so no Electron install or packaged app is needed.

Not run in CI (needs Chrome). Run it before shipping an installer.

## Run

From the repo root, with `npm install` done:

```sh
# 1. Backend + static frontend on :4199 (uses the cached mongodb-memory-server
#    binary under .cache/, downloads it on first run)
node tests/manual/update-guard/server.mjs

# 2. In another terminal: headless Chrome with a debugging port
google-chrome --headless=new --remote-debugging-port=9223 \
  --user-data-dir=/tmp/kg-guard-chrome --no-first-run --disable-gpu about:blank

# 3. In a third terminal: the driver (assertions + screenshots to /tmp/shots)
node tests/manual/update-guard/drive.mjs
```

Expected output: seven `ok:` lines and `ITEST_ALL_PASSED`; exit code 0.
Screenshots of the two guard dialogs land in `/tmp/shots/itest-*.png`.

## What it proves

- A pending mutating API request (a slow branch save) blocks the install:
  the dialog offers no discard and `installUpdate` is never called.
- The guard settles when the write settles.
- A form with unsaved edits forces an explicit decision; only the explicit
  "discard and install" choice installs, with `{ discardUnsaved: true }`.
- The renderer reports every guard-state change to the desktop process
  (`update-guard-state`), which is what the `update-install` IPC enforces.

All credentials in these scripts are local throwaway values for the
in-memory database only. No real account, token or secret is used.
