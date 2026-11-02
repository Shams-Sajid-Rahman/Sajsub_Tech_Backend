import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

const MAX_OUTPUT_TOKENS = 4000;
const REQUEST_TIMEOUT_MS = 30000;

// Every retry uses up the small free quota and keeps the customer waiting, so a failure
// is reported straight away. The customer can choose to try again.
const REQUEST_OPTIONS = { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 };

let client;
const getClient = () => {
  client ??= new GoogleGenAI({ apiKey: env.ai.apiKey });
  return client;
};

const toGeminiTool = ({ name, description, input_schema: { additionalProperties, ...parameters } }) => ({
  type: 'function',
  name,
  description,
  parameters,
});

// The conversation is sent in full each time, and model steps go back exactly as received,
// because they carry the signatures Gemini needs to continue.
const toGeminiStep = ({ role, content }) => {
  if (typeof content === 'string') {
    return [{ type: role === 'user' ? 'user_input' : 'model_output', content: [{ type: 'text', text: content }] }];
  }
  if (role === 'assistant') return content.map(({ step }) => step);
  return content.map(({ tool_use_id: callId, name, is_error: isError, content: result }) => ({
    type: 'function_result',
    call_id: callId,
    name,
    is_error: Boolean(isError),
    result,
  }));
};

const fromGeminiStep = (step) => {
  if (step.type === 'function_call') {
    return { type: 'tool_use', id: step.id, name: step.name, input: step.arguments, step };
  }
  if (step.type === 'model_output') {
    const text = (step.content ?? []).filter(({ type }) => type === 'text').map(({ text: part }) => part).join('');
    return { type: 'text', text, step };
  }
  return { type: step.type, step };
};

const toStopReason = ({ status }, content) => {
  if (status === 'failed') throw new Error('The model could not complete this request');
  if (content.some(({ type }) => type === 'tool_use')) return 'tool_use';
  return status === 'completed' ? 'end_turn' : 'incomplete';
};

// Kept as an object so tests can replace it and avoid real model calls.
export const llmClient = {
  isConfigured: () => Boolean(env.ai.apiKey),

  createMessage: async ({ system, tools, messages }) => {
    const interaction = await getClient().interactions.create(
      {
        model: env.ai.model,
        // This app keeps its own history, so nothing needs storing at Google between requests.
        store: false,
        // Cut-off answers aren't shown, so there's no point spending free quota continuing them.
        automatic_continuation: false,
        system_instruction: system,
        tools: tools.map(toGeminiTool),
        input: messages.flatMap(toGeminiStep),
        generation_config: { max_output_tokens: MAX_OUTPUT_TOKENS },
      },
      REQUEST_OPTIONS,
    );
    const content = (interaction.steps ?? []).map(fromGeminiStep);
    return { stop_reason: toStopReason(interaction, content), content };
  },
};

// Customers get a plain message. The reason goes to the log, and the key and prompt go nowhere.
export const toAssistantError = (error) => {
  if (error instanceof ApiError) return error;
  const { status } = error;
  if (status === 429) {
    console.error('Assistant reached the Gemini free limit');
    return new ApiError(503, 'The assistant is very busy right now. Please try again in a little while.');
  }
  if (status === 400 || status === 401 || status === 403) {
    console.error(`Gemini refused the request (${status}): check GEMINI_API_KEY`);
  } else if (status === 404) {
    console.error('Gemini could not find the model: check AI_MODEL');
  } else if (status) {
    console.error(`Gemini error ${status}`);
  } else {
    console.error('Assistant could not get an answer from Gemini');
  }
  return new ApiError(503, "The assistant isn't available right now. Please try again shortly.");
};
