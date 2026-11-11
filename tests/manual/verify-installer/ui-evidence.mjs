// UI evidence for the PUBLISHED installer (windows-latest).
//
// Runs after the real released NSIS installer was silently installed on a
// pristine runner. Launches THAT installed exe in embedded mode against a
// throwaway in-memory MongoDB (isolated from the user's production data) and
// captures the payers / branch-contacts UI in the real packaged window.
import path from 'path';
import { captureUiEvidence } from '../lib/ui-evidence.mjs';

const fail = (msg) => { console.error('UI-EVIDENCE FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('ui-evidence ok: ' + msg);

const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'KinderGuard', 'KinderGuard.exe');
await captureUiEvidence({ exe, outDir: path.resolve('published-ui-evidence'), cdpPort: 9225, fail, ok });
console.log('UI_EVIDENCE_PASSED');
process.exit(0);
