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

async function embed(text) {
    const response = await getClient().embeddings.create({
        model: env.EMBED_MODEL,
        input: text,
    });
    return response.data[0].embedding;
}

module.exports = { chatComplete, embed };
