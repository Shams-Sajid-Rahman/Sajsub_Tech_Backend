import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transporter = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    })
  : null;

export const sendContactEmail = async ({ name, email, subject, message }) => {
  if (!transporter) {
    if (env.isProduction) throw new Error('SMTP is not configured, so the contact message was not sent');
    console.log(`[dev email] Contact message from ${email}: ${subject}`);
    return;
  }
  await transporter.sendMail({
    from: env.emailFrom,
    to: env.emailFrom,
    replyTo: { name, address: email },
    subject: `Contact form: ${subject}`,
    text: `From: ${name} <${email}>\n\n${message}`,
  });
};

export const sendPasswordResetEmail = async (to, resetUrl) => {
  if (!transporter) {
    if (env.isProduction) throw new Error('SMTP is not configured, so the password reset email was not sent');
    console.log(`[dev email] Password reset link for ${to}: ${resetUrl}`);
    return;
  }
  await transporter.sendMail({
    from: env.emailFrom,
    to,
    subject: 'Reset your Sajsub Tech password',
    text: `Use this link to reset your password. It expires in 1 hour:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
  });
};
