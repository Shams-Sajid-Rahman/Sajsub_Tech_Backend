export const toSkipTake = ({ page, limit }) => ({ skip: (page - 1) * limit, take: limit });

export const buildPaginationMeta = ({ page, limit }, total) => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && total > 0,
  };
};
