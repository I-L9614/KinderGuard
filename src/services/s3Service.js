import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const getS3Client = () => {
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT;

  if (!bucket || !region) {
    throw new Error('S3_BUCKET_NAME and S3_REGION must be configured to use S3 operations.');
  }

  return {
    bucket,
    region,
    endpoint,
    client: new S3Client({
      region,
      endpoint,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    }),
  };
};

const getPublicUrl = (key, bucket, region, endpoint) => {
  if (endpoint) {
    return `${endpoint.replace(/\/$/, '')}/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

export const uploadFileToS3 = async (buffer, fileName, contentType) => {
  const { bucket, region, endpoint, client } = getS3Client();

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `licenses/${Date.now()}-${safeFileName}`;

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read',
  }));

  return getPublicUrl(key, bucket, region, endpoint);
};

