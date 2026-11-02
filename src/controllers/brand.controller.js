import { getBrandBySlug, listBrands } from '../services/brand.service.js';
import { buildPaginationMeta } from '../utils/pagination.js';
import { sendSuccess } from '../utils/response.js';

export const getBrands = async (req, res) => {
  const { query } = req.validated;
  const { brands, total } = await listBrands(query);
  sendSuccess(res, brands, { meta: buildPaginationMeta(query, total) });
};

export const getBrand = async (req, res) => {
  sendSuccess(res, await getBrandBySlug(req.validated.params.slug));
};
