import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 10;

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, index) => buffer[offset + index] === byte);
const ascii = (text) => [...Buffer.from(text, 'ascii')];

// Checks the file's actual bytes, because its name and declared type can be faked.
const isAllowedImage = (buffer) =>
  startsWith(buffer, [0xff, 0xd8, 0xff]) ||
  startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
  (startsWith(buffer, ascii('RIFF')) && startsWith(buffer, ascii('WEBP'), 8));

const storage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REQUEST },
});

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: [413, 'Each image must be 5 MB or smaller'],
  LIMIT_FILE_COUNT: [400, `Upload at most ${MAX_IMAGES_PER_REQUEST} images at a time`],
  LIMIT_UNEXPECTED_FILE: [400, 'Unexpected file field or too many files'],
};

const withValidation = (parse) => (req, res, next) => {
  parse(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const [status, message] = MULTER_MESSAGES[error.code] ?? [400, 'The upload could not be read'];
      next(new ApiError(status, message));
      return;
    }
    if (error) {
      next(new ApiError(400, 'The upload could not be read'));
      return;
    }
    const files = req.files ?? (req.file ? [req.file] : []);
    if (files.length === 0) {
      next(new ApiError(400, 'Choose at least one image'));
      return;
    }
    if (!files.every(({ buffer }) => isAllowedImage(buffer))) {
      next(new ApiError(400, 'Only JPEG, PNG and WebP images are allowed'));
      return;
    }
    next();
  });
};

export const uploadImagesField = withValidation(storage.array('images', MAX_IMAGES_PER_REQUEST));
export const uploadImageField = withValidation(storage.single('image'));
