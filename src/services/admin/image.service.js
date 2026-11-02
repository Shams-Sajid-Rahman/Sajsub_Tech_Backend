import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { destroyImages, uploadImages } from '../cloudinary.service.js';

const MAX_IMAGES_PER_PRODUCT = 20;
const PRODUCT_FOLDER = 'sajsub-tech/products';
const CATEGORY_FOLDER = 'sajsub-tech/categories';

const findProductImage = async (client, productId, imageId) => {
  const image = await client.productImage.findFirst({ where: { id: imageId, productId } });
  if (!image) throw new ApiError(404, 'Image not found');
  return image;
};

// Removes files that were uploaded if saving them to the database then fails.
const saveOrCleanUp = async (uploaded, save) => {
  try {
    return await save();
  } catch (error) {
    await destroyImages(uploaded.map(({ publicId }) => publicId));
    throw error;
  }
};

export const addProductImages = async (productId, files) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, _count: { select: { images: true } } },
  });
  if (!product) throw new ApiError(404, 'Product not found');
  if (product._count.images + files.length > MAX_IMAGES_PER_PRODUCT) {
    throw new ApiError(400, `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images`);
  }

  const uploaded = await uploadImages(files, PRODUCT_FOLDER);
  return saveOrCleanUp(uploaded, () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.productImage.findMany({ where: { productId }, select: { isPrimary: true, sortOrder: true } });
      const hasPrimary = existing.some(({ isPrimary }) => isPrimary);
      const nextOrder = Math.max(-1, ...existing.map(({ sortOrder }) => sortOrder)) + 1;
      await tx.productImage.createMany({
        data: uploaded.map(({ url, publicId }, index) => ({
          productId,
          url,
          publicId,
          altText: product.name,
          sortOrder: nextOrder + index,
          isPrimary: !hasPrimary && index === 0,
        })),
      });
      return tx.productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } });
    }),
  );
};

export const replaceProductImage = async (productId, imageId, file) => {
  const image = await findProductImage(prisma, productId, imageId);
  const uploaded = await uploadImages([file], PRODUCT_FOLDER);
  const updated = await saveOrCleanUp(uploaded, () =>
    prisma.productImage.update({
      where: { id: imageId },
      data: { url: uploaded[0].url, publicId: uploaded[0].publicId },
    }),
  );
  await destroyImages([image.publicId]);
  return updated;
};

export const setPrimaryProductImage = (productId, imageId) =>
  prisma.$transaction(async (tx) => {
    await findProductImage(tx, productId, imageId);
    await tx.productImage.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } });
    return tx.productImage.update({ where: { id: imageId }, data: { isPrimary: true } });
  });

export const deleteProductImage = async (productId, imageId) => {
  const image = await prisma.$transaction(async (tx) => {
    const found = await findProductImage(tx, productId, imageId);
    await tx.productImage.delete({ where: { id: imageId } });
    if (found.isPrimary) {
      const next = await tx.productImage.findFirst({ where: { productId }, orderBy: { sortOrder: 'asc' } });
      if (next) await tx.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return found;
  });
  await destroyImages([image.publicId]);
  return { id: imageId };
};

const findCategory = async (id) => {
  const category = await prisma.category.findUnique({ where: { id }, select: { imagePublicId: true } });
  if (!category) throw new ApiError(404, 'Category not found');
  return category;
};

export const setCategoryImage = async (id, file) => {
  const category = await findCategory(id);
  const uploaded = await uploadImages([file], CATEGORY_FOLDER);
  const updated = await saveOrCleanUp(uploaded, () =>
    prisma.category.update({
      where: { id },
      data: { imageUrl: uploaded[0].url, imagePublicId: uploaded[0].publicId },
    }),
  );
  await destroyImages([category.imagePublicId]);
  return updated;
};

export const removeCategoryImage = async (id) => {
  const category = await findCategory(id);
  const updated = await prisma.category.update({ where: { id }, data: { imageUrl: null, imagePublicId: null } });
  await destroyImages([category.imagePublicId]);
  return updated;
};
