import { describe, it, expect, beforeEach, vi } from 'vitest';

import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let uploadFileToS3;

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
});
describe('S3 Service', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.S3_BUCKET_NAME = 'bucket-name';
    process.env.S3_REGION = 'us-east-1';
  });

  it('uploads a file to S3 and returns a public URL', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const url = await uploadFileToS3(Buffer.from('hello'), 'test.pdf', 'application/pdf');

    expect(url).toContain('bucket-name');
    expect(s3Mock.calls()).toHaveLength(1);
  });
});
