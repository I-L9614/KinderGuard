// Local UI fixture server for screenshots: in-memory DB, one admin, three
// rent agreements (monthly / quarterly / annual). Not part of the test suite.
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongoServer = await MongoMemoryServer.create();
process.env.NODE_ENV = 'development';
process.env.MONGO_URI = mongoServer.getUri('kinderguard-ui');
process.env.JWT_SECRET = 'ui-fixture';
process.env.PORT = '4199';
process.env.HOST = '127.0.0.1';

const { startServer } = await import('../../src/server.js');
await startServer();

const { default: User } = await import('../../src/models/User.js');
const { default: Branch } = await import('../../src/models/Branch.js');
const { default: Authority } = await import('../../src/models/Authority.js');

await User.create({
  name: 'איתמר לוי',
  email: 'admin@example.com',
  password: 'Password123',
  role: 'Admin',
});

const base = 'http://127.0.0.1:4199';
const login = await fetch(`${base}/api/users/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'Password123' }),
}).then((r) => r.json());
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

const mk = async (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then((r) => r.json());
const branch = await mk('/api/branches', { name: 'גן שמש' });
const branch2 = await mk('/api/branches', { name: 'עפולה' });
const authority = await mk('/api/rent/authorities', { name: 'מועצה אזורית שפיר', type: 'council' });

await mk('/api/rent/agreements', { branchId: branch._id, authorityId: authority._id, monthlyAmount: 5000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: '2026-12-01' });
await mk('/api/rent/agreements', { branchId: branch._id, authorityId: authority._id, monthlyAmount: 8333.33, quarterlyAmount: 25000, frequency: 'quarterly', paymentMethod: 'cheque', firstDueDate: '2026-12-01' });
await mk('/api/rent/agreements', { branchId: branch2._id, authorityId: authority._id, annualAmount: 242399.8, frequency: 'annual', paymentMethod: 'transfer', firstDueDate: '2026-12-01' });

console.log('FIXTURE_READY');
setInterval(() => {}, 60000);
