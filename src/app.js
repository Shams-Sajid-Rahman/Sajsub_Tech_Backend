import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/error.middleware.js';
import healthRoutes from './routes/health.routes.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.clientUrl, credentials: true }));
app.use(express.json());
app.use(cookieParser());
if (env.nodeEnv === 'development') app.use(morgan('dev'));

app.use('/api/health', healthRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
