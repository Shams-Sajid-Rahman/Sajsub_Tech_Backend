import * as assistant from '../services/ai/assistant.service.js';
import { AI_GUEST_COOKIE, setGuestCookie } from '../utils/cookies.js';
import { sendSuccess } from '../utils/response.js';
import { generateToken, hashToken } from '../utils/tokens.js';

// Logged-in customers own their chats through their account, and guests through a private cookie.
const getViewer = (req, res) => {
  if (req.user) return { userId: req.user.id };
  let token = req.cookies?.[AI_GUEST_COOKIE];
  if (!token) {
    token = generateToken();
    setGuestCookie(res, token);
  }
  return { guestKeyHash: hashToken(token) };
};

export const sendMessage = async (req, res) => {
  sendSuccess(res, await assistant.sendMessage(getViewer(req, res), req.validated.body));
};

export const getConversation = async (req, res) => {
  sendSuccess(res, await assistant.getConversation(getViewer(req, res), req.validated.params.id));
};

export const deleteConversation = async (req, res) => {
  sendSuccess(res, await assistant.deleteConversation(getViewer(req, res), req.validated.params.id));
};
