import { coverageGate } from '../src/ai/capabilityRegistry.js';
const g = coverageGate();
console.log(`AI coverage: ${g.built} built, ${g.remaining.length - g.partial.length} planned, ${g.partial.length} partial (subset only), ${g.total} routes total.`);
if (g.partial.length) console.log('Partial (not full coverage):\n' + g.partial.map((r) => '  ' + r).join('\n'));
if (!g.complete) { console.log('Do NOT claim full business coverage. Remaining:\n' + g.remaining.map((r) => '  ' + r).join('\n')); process.exit(1); }
console.log('All routes are built or explicitly excluded.');
