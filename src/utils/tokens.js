import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ACCESS_TOKEN_MINUTES = 15;

const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'sajsub-tech' };

export const generateToken = () => randomBytes(32).toString('base64url');

// Refresh and reset tokens are stored hashed, so a database leak doesn't expose usable tokens.
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export const signAccessToken = ({ userId, sessionId }) =>
  jwt.sign({ sid: sessionId }, env.jwtSecret, {
    ...JWT_OPTIONS,
    subject: userId,
    expiresIn: `${ACCESS_TOKEN_MINUTES}m`,
  });

export const verifyAccessToken = (token, { ignoreExpiration = false } = {}) =>
  jwt.verify(token, env.jwtSecret, {
    algorithms: [JWT_OPTIONS.algorithm],
    issuer: JWT_OPTIONS.issuer,
    ignoreExpiration,
  });
