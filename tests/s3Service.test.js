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

  it('uploads a file privately (no public ACL) and returns its storage key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const key = await uploadFileToS3(Buffer.from('hello'), 'test.pdf', 'application/pdf');

    expect(key).toMatch(/^licenses\/\d+-test\.pdf$/);
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
