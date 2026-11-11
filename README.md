# Sajsub Tech Backend

REST API for the Sajsub Tech e-commerce store: products, cart, checkout, orders, payments, an admin API and an AI shopping assistant.

The storefront and admin dashboard that use this API are in [Sajsub_Tech_Frontend](https://github.com/Shams-Sajid-Rahman/Sajsub_Tech_Frontend).

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 20.9 or newer, ES modules |
| Framework | Express 5 |
| Database | PostgreSQL with Prisma 6 |
| Validation | Zod |
| Security | Helmet, rate limiting, CSRF protection, bcrypt password hashing |
| Payments | SSLCommerz |
| Images | Cloudinary |
| Email | Nodemailer (SMTP) |
| AI assistant | Google Gemini |

## Features

- Products, categories, brands, search, filters and reviews
- Cart, wishlist, addresses and checkout, with cash on delivery or online payment
- Orders with tracking, payments verified with SSLCommerz, and refund records
- Inventory with a full stock history
- Admin API for users, catalog, inventory, orders, payments, banners, settings and activity logs
- AI shopping assistant that reads prices and stock from the database through read-only tools
- Separate logins for the store and the admin dashboard, using HTTP-only cookies and rotating sessions

## Getting started

You need Node.js 20.9 or newer and PostgreSQL.

1. Create the database:

   ```bash
   psql -U postgres -h localhost -c "CREATE DATABASE sajsub_tech;"
   ```

2. Install the dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill it in. At minimum, set:
   - `DATABASE_URL`
   - `JWT_SECRET` and `CSRF_SECRET`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`

   `.env.example` explains every setting.

4. Set up the database and load the sample data:

   ```bash
   npm run db:deploy
   npm run db:generate
   npm run db:seed
   ```

5. Start the API:

   ```bash
   npm run dev
   ```

The API runs at `http://localhost:5000/api`. Check it at `http://localhost:5000/api/health`.

## Optional services

Each of these switches on once its settings are filled in. The rest of the API works without them.

| Feature | Settings |
| --- | --- |
| Image uploads | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Online payment | `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`; keep `SSLCOMMERZ_SANDBOX=true` for testing |
| Password reset and contact emails | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| AI shopping assistant | `GEMINI_API_KEY` |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the API and restarts it when files change |
| `npm start` | Starts the API |
| `npm test` | Runs the automated tests against the database in `DATABASE_URL` |
| `npm run db:deploy` | Applies database migrations |
| `npm run db:generate` | Generates the Prisma client |
| `npm run db:seed` | Loads development sample data; refuses to run in production |
| `npm run db:studio` | Opens Prisma Studio to browse the data |
| `npm run admin:create` | Creates an admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` |

## Project structure

```text
prisma/        Database schema, migrations and seed data
src/
  config/      Settings and database connection
  controllers/ Request handlers
  middleware/  Authentication, CSRF, validation, rate limits, errors
  routes/      API routes
  services/    Business logic, payments and the AI assistant
  validators/  Request validation rules
tests/         Automated tests
```

## Security notes

- Never commit `.env`. It is listed in `.gitignore`, and only `.env.example` belongs in the repository.
- Use long, random values for `JWT_SECRET` and `CSRF_SECRET`, different in every environment.
- There is no public admin registration. Admins are created with `npm run admin:create`.

## Documentation

The full API reference, payment and AI assistant guides, and the audit report are in the `docs` folder of the [main Sajsub Tech repository](https://github.com/Shams-Sajid-Rahman/Sajsub_Tech).
