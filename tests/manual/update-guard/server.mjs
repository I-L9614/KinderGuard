// Real backend + real frontend for the update-guard integration test.
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'itest-secret';
process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.S3_REGION = 'us-east-1';

const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
const mongo = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
process.env.MONGO_URI = mongo.getUri();

const { default: app } = await import(process.cwd() + '/src/app.js');
app.listen(4199, () => console.log('ITEST_SERVER_UP'));
