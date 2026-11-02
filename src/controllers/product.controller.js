import { getProductBySlug, listProducts } from '../services/product.service.js';
import { buildPaginationMeta } from '../utils/pagination.js';
import { sendSuccess } from '../utils/response.js';

export const getProducts = async (req, res) => {
  const { query } = req.validated;
  const { products, total } = await listProducts(query);
  sendSuccess(res, products, { meta: buildPaginationMeta(query, total) });
};

export const getProduct = async (req, res) => {
  sendSuccess(res, await getProductBySlug(req.validated.params.slug));
};
