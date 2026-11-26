import { it, expect, vi } from 'vitest';
import request from 'supertest';
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn() }));
it('AI_ENABLED=false: the real app entry does not expose any AI route', async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.MONGO_URI = 'mongodb://127.0.0.1:1/none'; process.env.AI_ENABLED = 'false';
  const app = (await import('../src/app.js')).default;
  for (const p of ['/api/ai/ask', '/api/ai/agreements/document/delete-propose']) expect((await request(app).post(p).send({ prompt: 'x' })).status).toBe(404);
});
