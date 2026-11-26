import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AI_CAPABILITIES, STATUSES, TIERS, coverageGate } from '../src/ai/capabilityRegistry.js';

const MOUNTS = { authRoutes: 'auth', branchRoutes: 'branches', importRoutes: 'import', licenseRoutes: 'licenses', licenseTypeRoutes: 'license-types', notificationRoutes: 'notifications', rentRoutes: 'rent', taskRoutes: 'tasks', userRoutes: 'users' };
const routes = () => {
  const dir = path.resolve('src/routes'); const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const mount = MOUNTS[f.slice(0, -3)];
    expect(mount, `route file ${f} has no mount mapping in this test`).toBeTruthy();
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)) out.push(`${m[1].toUpperCase()} /api/${mount}${m[2] === '/' ? '' : m[2]}`);
  }
  return out;
};
describe('AI capability registry', () => {
  it('lists every route of the app, and nothing stale', () => {
    const actual = routes().sort(); const listed = Object.keys(AI_CAPABILITIES).sort();
    expect(actual.filter((r) => !listed.includes(r)), 'routes without an AI classification').toEqual([]);
    expect(listed.filter((r) => !actual.includes(r)), 'registry entries for routes that no longer exist').toEqual([]);
  });
  it('uses only known statuses and tiers; auth/security routes are never AI-enabled', () => {
    for (const [r, v] of Object.entries(AI_CAPABILITIES)) { expect(STATUSES).toContain(v.status); expect(TIERS).toContain(v.tier); if (v.tier === 'security') expect(v.status, r).toBe('excluded'); if (v.tier === 'permissions' && v.status === 'built') expect(v.stepUp, r).toBe(true); }
  });
});

describe('coverage release gate', () => {
  it('is incomplete while any entry is planned, complete only when none is', () => {
    expect(coverageGate({ 'GET /a': { status: 'built' }, 'POST /b': { status: 'plan' }, 'GET /c': { status: 'excluded' } })).toMatchObject({ complete: false, remaining: ['POST /b'], built: 1 });
    expect(coverageGate({ 'GET /a': { status: 'built' }, 'GET /c': { status: 'excluded' } }).complete).toBe(true);
  });
  it('reports honestly today: full business coverage is NOT claimable while routes remain planned', () => {
    const g = coverageGate();
    expect(g.built).toBeGreaterThan(0);
    if (!g.complete) expect(g.remaining.length).toBeGreaterThan(0); // flips only when the last planned route is built or excluded
  });
  it('a partial route blocks the full-coverage claim and says what it covers', () => {
    const g = coverageGate({ 'GET /a': { status: 'partial', covers: 'names only' }, 'GET /c': { status: 'excluded' } });
    expect(g.complete).toBe(false); expect(g.partial[0]).toContain('names only');
  });
});
