import { prisma } from '../config/prisma.js';

// Subscribing twice changes nothing, and the response never reveals whether an email was already on the list.
export const subscribeToNewsletter = ({ email }) =>
  prisma.newsletterSubscriber.upsert({ where: { email }, update: {}, create: { email } });
