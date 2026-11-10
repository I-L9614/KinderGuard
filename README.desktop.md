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

## Package the desktop app

Run `npm run dist`. Installers are written to `dist/`.
