import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const { cloudName, apiKey, apiSecret } = env.cloudinary;
const isConfigured = Boolean(cloudName && apiKey && apiSecret);

if (isConfigured) {
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

const requireConfigured = () => {
  if (!isConfigured) throw new ApiError(503, 'Image uploads are not configured yet');
};

// Kept as an object so tests can replace it and avoid real uploads.
export const imageStorage = {
  upload: (buffer, folder) => {
    requireConfigured();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'image' }, (error, result) => {
        if (error) reject(new ApiError(502, 'The image could not be uploaded'));
        else resolve({ url: result.secure_url, publicId: result.public_id });
      });
      stream.end(buffer);
    });
  },
  destroy: async (publicId) => {
    requireConfigured();
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  },
};

// The database record is already gone by now, so a failure here only leaves an unused file.
export const destroyImages = async (publicIds) => {
  const results = await Promise.allSettled(publicIds.filter(Boolean).map((id) => imageStorage.destroy(id)));
  for (const { status, reason } of results) {
    if (status === 'rejected') console.error('Could not delete an image from Cloudinary:', reason.message);
  }
};

// All or nothing: if any upload fails, the ones that worked are removed.
export const uploadImages = async (files, folder) => {
  const results = await Promise.allSettled(files.map(({ buffer }) => imageStorage.upload(buffer, folder)));
  const failure = results.find(({ status }) => status === 'rejected');
  if (failure) {
    await destroyImages(results.filter(({ status }) => status === 'fulfilled').map(({ value }) => value.publicId));
    throw failure.reason;
  }
  return results.map(({ value }) => value);
};
