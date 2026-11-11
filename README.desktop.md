# KinderGuard Desktop

KinderGuard helps a daycare operator manage permits and renewal work across multiple branches.

## What it does

- Keeps branches and permit records in one account, with no chain/network layer.
- Lets the account administrator create users and grant access to selected branches.
- Lets the administrator define permit types for every branch or for one branch.
- Stores issue and expiry dates and uploaded permit files.
- Keeps every replaced permit in the branch's renewal history.
- Creates persistent reminders 30 days before expiry, 7 days before expiry, and on expiry day.
- Shows open and completed reminders in a shared inbox; users can mark reminders in progress or resolved.
- Sends native desktop notifications while the app is running, including when it is hidden in the tray.

## Requirements

- Node.js 20+
- MongoDB
- An AWS S3 bucket for uploaded permit files

## New installation

1. Copy `.env.example` to `.env` and configure `MONGO_URI`, `JWT_SECRET`, `S3_BUCKET_NAME`, and `S3_REGION`.
2. Install dependencies with `npm install`.
3. Launch with `npm run electron`.
4. Create the first administrator account from the sign-in screen. The administrator can add users and assign branches from **הגדרות וצוות**.

## In-app updates

The packaged app checks GitHub Releases for a newer version on startup and every few hours. When one exists, a yellow dot appears on the update button in the top bar. Nothing downloads or installs on its own: the user clicks the button, approves the download, and then approves the installation. Installing closes the app by itself, runs the installer and reopens the new version - no manual quit. Saved data, settings and uploaded permits live outside the install folder and carry over. Because installing closes the app immediately, a guard (`frontend/updateGuard.js`) tracks real at-risk state - a modal form with unsaved edits or an in-flight file upload - and demands an explicit choice before the install runs: go back and save, discard and install anyway, or cancel. Choosing "later" defers without any hidden commitment - the update never installs on an unrelated quit (`autoInstallOnAppQuit` is off).

Update integrity: the downloaded installer is verified against the SHA-512 hash published in the release metadata fetched over HTTPS from GitHub Releases. Publisher signature verification (`verifyUpdateCodeSignature` against `publisherName`) only activates when the build is signed and `win.publisherName` is set; current builds are unsigned, so that check is inactive and Windows SmartScreen may warn on install. Signing requires a certificate purchase and is a separate decision.

To ship an update: bump `version` in `package.json`, then build the installer from **Actions → Build Windows installer** (manual `workflow_dispatch`, runs on a real Windows runner, tests first, no publish, no secrets) and download the `KinderGuard Setup <version>.exe` + `latest.yml` artifacts. Create a GitHub Release on `I-L9614/KinderGuard` with a tag `v<version>` and attach both files. Installed apps pick it up from there. GitHub Releases and Windows runner minutes are free for this public repo. Building the NSIS installer locally on Linux requires wine; the runner route avoids that. Updates are not code-signed yet, so Windows SmartScreen may warn on install; signing requires a certificate purchase and is a separate decision.

Before shipping an installer, run the manual update-guard integration test in `tests/manual/update-guard/`.

## Package the desktop app

Run `npm run dist`. Installers are written to `dist/`.
