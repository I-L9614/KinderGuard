import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

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
    client: new S3Client({
      region,
      endpoint: endpoint || undefined,
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    }),
  };
};

// Uploads stay private: no ACL, no public URL. The returned key is stored on the
// license and files are served only through the authenticated download route.
export const uploadFileToS3 = async (buffer, fileName, contentType) => {
  const { bucket, client } = getS3Client();

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `licenses/${Date.now()}-${safeFileName}`;

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  return key;
};

export const downloadFileFromS3 = async (key) => {
  const { bucket, client } = getS3Client();
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
};

export const deleteFileFromS3 = async (key) => {
  const { bucket, client } = getS3Client();
  return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};
