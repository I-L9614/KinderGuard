import { describe, it, expect, beforeEach, vi } from 'vitest';

import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

let uploadFileToS3;
let downloadFileFromS3;

const s3Mock = mockClient(S3Client);

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env.S3_BUCKET_NAME = 'bucket-name';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = 'testkey';
  process.env.S3_SECRET_ACCESS_KEY = 'testsecret';

  const module = await import('../src/services/s3Service.js');
  uploadFileToS3 = module.uploadFileToS3;
  downloadFileFromS3 = module.downloadFileFromS3;
});
describe('S3 Service', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.S3_BUCKET_NAME = 'bucket-name';
    process.env.S3_REGION = 'us-east-1';
  });

  it('identical timestamp and identical sanitized filename still get distinct keys, and both objects are written', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const [k1, k2] = await Promise.all([uploadFileToS3(Buffer.from('a'), 'חוזה.pdf', 'application/pdf', 'rent'), uploadFileToS3(Buffer.from('b'), 'הסכם.pdf', 'application/pdf', 'rent')]);
    expect(k1).not.toBe(k2); expect(k1).toMatch(/^rent\/1700000000000-/); expect(k1.endsWith('____.pdf') || k1.endsWith('___.pdf') || k1.endsWith('.pdf')).toBe(true);
    const puts = s3Mock.commandCalls(PutObjectCommand); expect(puts).toHaveLength(2);
    expect(new Set(puts.map((c) => c.args[0].input.Key)).size).toBe(2);
    expect(puts.map((c) => c.args[0].input.Body.toString()).sort()).toEqual(['a', 'b']);
    const long = await uploadFileToS3(Buffer.from('c'), `${'x'.repeat(400)}.pdf`, 'application/pdf');
    expect(long.length).toBeLessThan(200);
    Date.now.mockRestore();
  });

  it('uploads a file privately (no public ACL) and returns its storage key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const key = await uploadFileToS3(Buffer.from('hello'), 'test.pdf', 'application/pdf');

    expect(key).toMatch(/^licenses\/\d+-[0-9a-f-]{36}-test\.pdf$/);
    expect(key).not.toContain('bucket-name');
    expect(key).not.toMatch(/^https?:/);
    const calls = s3Mock.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ACL).toBeUndefined();
    expect(calls[0].args[0].input.Bucket).toBe('bucket-name');
    expect(calls[0].args[0].input.ContentType).toBe('application/pdf');
  });

  it('downloads a file by its storage key', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(['file-contents']),
      ContentType: 'application/pdf',
      ContentLength: 13,
    });

    const result = await downloadFileFromS3('licenses/123-test.pdf');

    expect(result.ContentType).toBe('application/pdf');
    const calls = s3Mock.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Bucket).toBe('bucket-name');
    expect(calls[0].args[0].input.Key).toBe('licenses/123-test.pdf');
  });
});
