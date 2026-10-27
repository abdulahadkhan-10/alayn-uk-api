import fs from 'fs';
import path from 'path';
import { uploadToWasabi, deleteFromWasabi } from './s3Config';
import { AppError } from './AppError';

const WASABI_KEYS = ['WASABI_ACCESS_KEY', 'WASABI_SECRET_KEY', 'WASABI_BUCKET_NAME'] as const;

/**
 * Stores an uploaded image in Wasabi and returns its media URL. Local disk is a development
 * fallback only: in production a missing setting or a failed upload is an error the user sees,
 * since files on the server's disk are not in the bucket and can be lost on redeploy.
 */
export const saveBase64Image = async (base64String: string | undefined, folderName: string): Promise<string | null> => {
  if (!base64String || !base64String.startsWith('data:image/')) {
    console.log('[saveBase64Image] Missing or invalid prefix');
    return null;
  }

  const parts = base64String.split(';base64,');
  if (parts.length !== 2) {
    console.log('[saveBase64Image] Split failed');
    return null;
  }

  const type = parts[0].replace('data:', ''); // 'image/jpeg'
  let extension = type.split('/')[1] || 'png';
  if (extension === 'jpeg') extension = 'jpg';

  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${extension}`;
  const fileBuffer = Buffer.from(parts[1], 'base64');
  const s3Key = `${folderName}/${fileName}`;
  const isProduction = process.env.NODE_ENV === 'production';

  const missing = WASABI_KEYS.filter((k) => !process.env[k]?.trim());
  if (missing.length === 0) {
    try {
      await uploadToWasabi(fileBuffer, s3Key, type);
      console.log(`[saveBase64Image] Uploaded successfully to Wasabi: ${s3Key}`);
      return `/api/v1/media/${s3Key}`;
    } catch (error: any) {
      const reason = `${error?.Code || error?.name || 'Error'}: ${error?.message || 'unknown error'}`;
      console.error(`[saveBase64Image] Wasabi upload of ${s3Key} to bucket "${process.env.WASABI_BUCKET_NAME}" failed. ${reason}`);
      if (isProduction) {
        throw new AppError('IMAGE_UPLOAD_FAILED', `The image could not be saved to storage. ${reason}`, 502);
      }
      console.warn('[saveBase64Image] Falling back to local disk storage for development.');
    }
  } else {
    console.warn(`[saveBase64Image] Wasabi not configured (missing ${missing.join(', ')}). Falling back to local disk storage for development.`);
    if (isProduction) {
      throw new AppError('IMAGE_STORAGE_NOT_CONFIGURED', `Image storage is not set up on the server (missing ${missing.join(', ')}).`, 500);
    }
  }

  // Development fallback
  try {
    const uploadDir = path.resolve(__dirname, '../../uploads', folderName);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, fileBuffer);
    console.log('[saveBase64Image] Saved image locally to:', filePath);
    return `/api/v1/media/${s3Key}`;
  } catch (error) {
    console.error('Error saving base64 image:', error);
    return null;
  }
};

export const deleteImageFile = async (imageUrl: string | null | undefined): Promise<void> => {
  if (!imageUrl) return;

  try {
    if (imageUrl.startsWith('/api/v1/media/')) {
      const key = imageUrl.replace('/api/v1/media/', '');
      console.log(`[deleteImageFile] Deleting Wasabi S3 key: ${key}`);
      await deleteFromWasabi(key);
    } else {
      // Fallback for local files if they are absolute/relative paths on disk
      const localPath = path.resolve(__dirname, '../../uploads', imageUrl.replace('/uploads/', ''));
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log(`[deleteImageFile] Deleted local file: ${localPath}`);
      }
    }
  } catch (error) {
    console.error('[deleteImageFile] Error deleting image file:', error);
  }
};
