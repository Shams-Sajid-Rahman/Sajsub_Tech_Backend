import morgan from 'morgan';
import { env } from '../config/env.js';

// Logs the method, path and status only. Query strings stay out of production logs.
morgan.token('path', (req) => req.originalUrl.split('?')[0]);

const PRODUCTION_FORMAT = ':remote-addr :method :path :status :res[content-length] - :response-time ms';

export const requestLogger = morgan(env.nodeEnv === 'production' ? PRODUCTION_FORMAT : 'dev', {
  skip: () => env.nodeEnv === 'test',
});
