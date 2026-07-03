const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const ROOT_DIR = path.join(__dirname, '..');
const PRIVATE_DIR = path.join(ROOT_DIR, 'private');
const MANUAL_PATH = path.join(PRIVATE_DIR, 'manual_clean.txt');
const AUTH_PATH = path.join(PRIVATE_DIR, 'auth.json');
const SESSIONS_DIR = path.join(PRIVATE_DIR, 'sessions');

const NAVIGATOR_API_KEY = process.env.NAVIGATOR_API_KEY || '';
const NAVIGATOR_BASE_URL = process.env.NAVIGATOR_BASE_URL || 'https://api.ai.it.ufl.edu/v1';
const CHAT_MODEL = 'gpt-oss-120b';
const EMBED_MODEL = 'nomic-embed-text-v1.5';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const CHROMA_COLLECTION = 'game_room_manual';

const PORT = parseInt(process.env.PORT, 10) || 3000;

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set in .env — using a random ephemeral secret for this run. Sessions will not survive a restart. Set SESSION_SECRET in .env for production.');
}

const RELEVANCE_THRESHOLD = parseFloat(process.env.RELEVANCE_THRESHOLD) || 0.35;
const LIVE_CACHE_TTL_MINUTES = parseFloat(process.env.LIVE_CACHE_TTL_MINUTES) || 30;

function hasApiKey() {
    return Boolean(NAVIGATOR_API_KEY);
}

function hasManual() {
    return fs.existsSync(MANUAL_PATH);
}

function ensurePrivateDir() {
    if (!fs.existsSync(PRIVATE_DIR)) {
        fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    }
}

function ensureSessionsDir() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
}

module.exports = {
    ROOT_DIR,
    PRIVATE_DIR,
    MANUAL_PATH,
    AUTH_PATH,
    SESSIONS_DIR,
    NAVIGATOR_API_KEY,
    NAVIGATOR_BASE_URL,
    CHAT_MODEL,
    EMBED_MODEL,
    CHROMA_URL,
    CHROMA_COLLECTION,
    PORT,
    SESSION_SECRET,
    RELEVANCE_THRESHOLD,
    LIVE_CACHE_TTL_MINUTES,
    hasApiKey,
    hasManual,
    ensurePrivateDir,
    ensureSessionsDir,
};
