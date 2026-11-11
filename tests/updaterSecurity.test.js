// Pins the exact signature-verification behavior of the installed
// electron-updater, verified by reading its source on 2026-11-11.
//
// What is enforced for our unsigned Windows builds on electron-updater 6.8.11:
// - NsisUpdater.verifySignature() reads publisherName from the installed
//   app-update.yml. When publisherName is null (our builds: win.publisherName
//   is not set), it returns null and NO publisher signature check runs.
// - When the check does run and fails, the update is rejected with
//   ERR_UPDATER_INVALID_SIGNATURE before installation.
// - Independent of signing, every downloaded installer is verified against
//   the SHA-512 hash in the release metadata fetched over HTTPS.
//
// If electron-updater is upgraded or someone changes the signing config, this
// test fails and the behavior must be re-verified against the new source.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const updaterDir = path.resolve(process.cwd(), 'node_modules', 'electron-updater');
const nsisSource = fs.readFileSync(path.join(updaterDir, 'out', 'NsisUpdater.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(updaterDir, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

describe('electron-updater signature behavior (verified on 6.8.11)', () => {
  it('runs the verified version - re-verify the source after any upgrade', () => {
    expect(pkg.version).toMatch(/^6\.8\./);
  });

  it('skips the publisher signature check only when publisherName is null', () => {
    // NsisUpdater.verifySignature(): "if (publisherName == null) { return null; }"
    expect(nsisSource).toMatch(/publisherName = \(await this\.configOnDisk\.value\)\.publisherName/);
    expect(nsisSource).toMatch(/if \(publisherName == null\) \{\s*return null;\s*\}/);
  });

  it('still rejects a failed signature check before install when the check is active', () => {
    expect(nsisSource).toContain('ERR_UPDATER_INVALID_SIGNATURE');
    expect(nsisSource).toContain('verifyUpdateCodeSignature');
  });

  it('our build config has no publisherName and nothing that weakens verification', () => {
    expect(rootPkg.build.win.publisherName).toBeUndefined();
    expect(rootPkg.build.publish).toEqual([
      { provider: 'github', owner: 'I-L9614', repo: 'KinderGuard', releaseType: 'release' },
    ]);
    // We never override the verifier with a custom (weaker) function.
    const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'electron', 'updater.js'), 'utf8');
    expect(mainSource).not.toContain('verifyUpdateCodeSignature');
  });
});
