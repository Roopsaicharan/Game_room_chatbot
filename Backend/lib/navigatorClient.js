const OpenAI = require('openai');
const env = require('../config/env');

const REQUEST_TIMEOUT_MS = 30000;

let client = null;

function getClient() {
    if (!env.hasApiKey()) {
        throw new Error('NAVIGATOR_API_KEY is not configured');
    }
    if (!client) {
        client = new OpenAI({
            apiKey: env.NAVIGATOR_API_KEY,
            baseURL: env.NAVIGATOR_BASE_URL,
            timeout: REQUEST_TIMEOUT_MS,
            maxRetries: 1,
        });
    }
    return client;
}

async function chatComplete(messages, options = {}) {
    const response = await getClient().chat.completions.create({
        model: env.CHAT_MODEL,
        messages,
        temperature: options.temperature ?? 0.2,
    });
    return response.choices[0].message.content;
}

// Streaming variant — yields text deltas as the model produces them, instead of waiting for
// the full completion. Used by routes/chat.js to start rendering an answer before generation
// finishes; callers are responsible for their own safety checks on the accumulated text (the
// output guard can't run on a single complete string anymore — see streamGuardedReply()).
async function* chatCompleteStream(messages, options = {}) {
    const stream = await getClient().chat.completions.create({
        model: env.CHAT_MODEL,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: true,
    });
    for await (const part of stream) {
        const delta = part.choices?.[0]?.delta?.content;
        if (delta) yield delta;
    }
}

async function embed(text) {
    const response = await getClient().embeddings.create({
        model: env.EMBED_MODEL,
        input: text,
    });
    return response.data[0].embedding;
}

module.exports = { chatComplete, chatCompleteStream, embed };
