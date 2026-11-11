import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import Branch from '../src/models/Branch.js';
import Authority from '../src/models/Authority.js';

let app;
let mongoServer;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `import-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Payers and branches import', () => {
  it('creates councils and private payers with typed branches and links', async () => {
    const res = await request(app).post('/api/import/payers-branches').set(auth()).send({
      authorities: [
        { name: 'מועצה אזורית מרחבים', type: 'council' },
        { name: 'דדוש', type: 'private' },
      ],
      branches: [
        { name: 'אשבול', address: 'אשבול', managerName: 'רעות', phone: '052-6651161', emails: ['eshbol@example.com'], authorityName: 'מועצה אזורית מרחבים' },
        { name: 'עילאי', address: 'משה הס 19', managerName: 'שרה', phone: '050-6986262', emails: ['ilay@example.com'], authorityName: 'דדוש' },
      ],
    }).expect(200);
    expect(res.body.authorities.created.sort()).toEqual(['דדוש', 'מועצה אזורית מרחבים'].sort());
    expect(res.body.branches.created.sort()).toEqual(['אשבול', 'עילאי'].sort());

    const council = await Authority.findOne({ name: 'מועצה אזורית מרחבים' });
    const landlord = await Authority.findOne({ name: 'דדוש' });
    expect(council.type).toBe('council');
    expect(landlord.type).toBe('private');
    const branch = await Branch.findOne({ name: 'אשבול' });
    expect(String(branch.authorityId)).toBe(String(council._id));
    expect(branch.managerName).toBe('רעות');
    expect(branch.emails).toEqual(['eshbol@example.com']);
  });

  it('is idempotent and never overwrites existing branch data', async () => {
    await request(app).post('/api/branches').set(auth()).send({ name: 'קיים', address: 'רחוב הישן 1' }).expect(201);
    const res = await request(app).post('/api/import/payers-branches').set(auth()).send({
      authorities: [{ name: 'דדוש', type: 'private' }],
      branches: [
        { name: 'אשבול', address: 'כתובת אחרת', managerName: 'אחר', phone: '000', authorityName: 'מועצה אזורית מרחבים' },
        { name: 'קיים', address: 'רחוב חדש 2', managerName: 'דנה', authorityName: 'דדוש' },
      ],
    }).expect(200);
    expect(res.body.authorities.existing).toContain('דדוש');
    expect(res.body.branches.skipped).toContain('אשבול'); // everything already set - untouched
    expect(res.body.branches.updated).toContain('קיים'); // empty fields filled only

    const kept = await Branch.findOne({ name: 'אשבול' });
    expect(kept.managerName).toBe('רעות'); // not overwritten
    const filled = await Branch.findOne({ name: 'קיים' });
    expect(filled.address).toBe('רחוב הישן 1'); // existing value wins
    expect(filled.managerName).toBe('דנה'); // empty field filled
    const landlord = await Authority.findOne({ name: 'דדוש' });
    expect(String(filled.authorityId)).toBe(String(landlord._id));
    expect(await Branch.countDocuments({ name: 'אשבול' })).toBe(1);
  });

  it('creates a payer referenced by a branch even when missing from the authorities list', async () => {
    await request(app).post('/api/import/payers-branches').set(auth()).send({
      branches: [{ name: 'בודק', authorityName: 'גוף חדש' }],
    }).expect(200);
    const authority = await Authority.findOne({ name: 'גוף חדש' });
    expect(authority.type).toBe('council');
    const branch = await Branch.findOne({ name: 'בודק' });
    expect(String(branch.authorityId)).toBe(String(authority._id));
  });

  it('imported branches work in both modules: permits and rent', async () => {
    const branch = await Branch.findOne({ name: 'אשבול' });
    // Permits: a license type and a rent agreement both accept the same branch.
    const type = await request(app).post('/api/license-types').set(auth()).send({ name: 'רישיון עסק', branchId: branch._id }).expect(201);
    expect(type.body.name).toBe('רישיון עסק');
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId: branch._id, authorityId: branch.authorityId, monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date(Date.now() + 86400000 * 10),
    }).expect(201);
    expect(agreement.body.branchId).toBe(String(branch._id));
  });

  it('branch update endpoint edits contact fields and validates the payer link', async () => {
    const branch = await Branch.findOne({ name: 'קיים' });
    const landlord = await Authority.findOne({ name: 'דדוש' });
    const res = await request(app).patch(`/api/branches/${branch._id}`).set(auth()).send({ managerName: 'משה', emails: 'a@b.co; c@d.co', authorityId: landlord._id }).expect(200);
    expect(res.body.managerName).toBe('משה');
    expect(res.body.emails).toEqual(['a@b.co', 'c@d.co']);
    await request(app).patch(`/api/branches/${branch._id}`).set(auth()).send({ authorityId: new mongoose.Types.ObjectId() }).expect(400);
  });
});
