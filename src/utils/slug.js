import { randomBytes } from 'node:crypto';

const MAX_SLUG_LENGTH = 200;
const FALLBACK_BASE = 'item';

export const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);

// Names in Bangla have no Latin letters to build from, and two products can share a name,
// so this always returns a working address that isn't already taken.
export const uniqueSlug = async (model, name) => {
  const base = slugify(name) || FALLBACK_BASE;
  const taken = await model.count({ where: { slug: base } });
  return taken === 0 && base !== FALLBACK_BASE ? base : `${base}-${randomBytes(3).toString('hex')}`;
};
