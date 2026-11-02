import { ApiError } from '../utils/ApiError.js';

// Validates request parts against Zod schemas, e.g. validate({ query: schema }).
// Parsed values go on req.validated, because req.query is read-only in Express 5.
export const validate = (schemas) => (req, res, next) => {
  const validated = {};
  const errors = [];

  for (const [part, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(req[part]);
    if (result.success) {
      validated[part] = result.data;
    } else {
      errors.push(
        ...result.error.issues.map((issue) => ({
          location: part,
          field: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
  }

  if (errors.length > 0) throw new ApiError(400, 'Validation failed', errors);
  req.validated = validated;
  next();
};
