const PUBLIC_MAX_AGE_SECONDS = 60;

// API responses can hold accounts, carts, live prices and stock, so nothing is stored by default.
export const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// For public content that changes rarely. An admin's edit shows within a minute.
export const publicCache = (req, res, next) => {
  res.set('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE_SECONDS}`);
  next();
};
