import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const region = (process.env.WASABI_REGION || 'ap-southeast-1').trim();
const endpoint = (
  process.env.WASABI_ENDPOINT ||
  (region === 'us-east-1' ? 'https://s3.wasabisys.com' : `https://s3.${region}.wasabisys.com`)
).trim();

export const s3Client = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId: (process.env.WASABI_ACCESS_KEY || '').trim(),
    secretAccessKey: (process.env.WASABI_SECRET_KEY || '').trim(),
  },
  forcePathStyle: true, // Required for Wasabi S3 compatibility
});

export const getWasabiBucketName = (): string => {
  return (process.env.WASABI_BUCKET_NAME || '').trim();
};

/**
 * Uploads a file buffer to Wasabi S3 bucket.
 * Throws errors directly so callers can properly handle or report them.
 */
export const uploadToWasabi = async (
  fileBuffer: Buffer,
  key: string,
  contentType: string
): Promise<void> => {
  const bucket = getWasabiBucketName();
  if (!bucket) {
    throw new Error('WASABI_BUCKET_NAME is not configured.');
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await s3Client.send(command);
};

/**
 * Deletes an object from the Wasabi S3 bucket by its key.
 */
export const deleteFromWasabi = async (key: string): Promise<boolean> => {
  try {
    const bucket = getWasabiBucketName();
    if (!bucket) return false;

    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error(`[deleteFromWasabi] Error deleting "${key}" from Wasabi S3:`, error);
    return false;
  }
};

