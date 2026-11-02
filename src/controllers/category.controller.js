import { getCategoryBySlug, listCategories } from '../services/category.service.js';
import { buildPaginationMeta } from '../utils/pagination.js';
import { sendSuccess } from '../utils/response.js';

export const getCategories = async (req, res) => {
  const { query } = req.validated;
  const { categories, total } = await listCategories(query);
  sendSuccess(res, categories, { meta: buildPaginationMeta(query, total) });
};

export const getCategory = async (req, res) => {
  sendSuccess(res, await getCategoryBySlug(req.validated.params.slug));
};
