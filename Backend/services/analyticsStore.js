const fs = require('fs');
const path = require('path');
const env = require('../config/env');

// Lightweight append-only logs so admins can see what visitors and staff actually ask — and,
// crucially, what the bot COULDN'T answer (the data that tells you which manual gaps to fill).
// JSONL keeps appends cheap and the files greppable. Stored under private/ (git-ignored).
// Single-instance scale; if volume grows, rotate these or move to a real datastore.
const QUESTION_LOG = path.join(env.PRIVATE_DIR, 'questions.jsonl');
const FEEDBACK_LOG = path.join(env.PRIVATE_DIR, 'feedback.jsonl');

function appendLine(file, obj) {
    try {
        env.ensurePrivateDir();
        fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (error) {
        // Analytics must never break the chat path — log and move on.
        console.warn('analyticsStore append failed:', error.message);
    }
}

function readTail(file, limit) {
    try {
        if (!fs.existsSync(file)) return [];
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const slice = limit ? lines.slice(-limit) : lines;
        return slice
            .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
            .filter(Boolean)
            .reverse(); // newest first
    } catch (error) {
        console.warn('analyticsStore read failed:', error.message);
        return [];
    }
}

// answered=false marks the turns worth an admin's attention: refusals and "no evidence"
// non-answers, i.e. questions the current knowledge base couldn't satisfy.
function logQuestion({ role, intent, question, answered, citationType }) {
    appendLine(QUESTION_LOG, {
        at: new Date().toISOString(),
        role: role || 'public',
        intent: intent || null,
        question: String(question || '').slice(0, 500),
        answered: Boolean(answered),
        citationType: citationType || null,
    });
}

function logFeedback({ role, rating, question, answer }) {
    appendLine(FEEDBACK_LOG, {
        at: new Date().toISOString(),
        role: role || 'public',
        rating: rating === 'up' ? 'up' : 'down',
        question: String(question || '').slice(0, 500),
        answer: String(answer || '').slice(0, 1000),
    });
}

function recentQuestions(limit = 100) {
    return readTail(QUESTION_LOG, limit);
}

function unansweredQuestions(limit = 100) {
    return readTail(QUESTION_LOG, null).filter((q) => q.answered === false).slice(0, limit);
}

function recentFeedback(limit = 100) {
    return readTail(FEEDBACK_LOG, limit);
}

function summary() {
    const all = readTail(QUESTION_LOG, null);
    const total = all.length;
    const unanswered = all.filter((q) => q.answered === false).length;
    const byIntent = all.reduce((acc, q) => {
        const key = q.intent || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const fb = readTail(FEEDBACK_LOG, null);
    return {
        totalQuestions: total,
        unanswered,
        answeredRate: total ? Number(((total - unanswered) / total).toFixed(3)) : null,
        byIntent,
        feedback: {
            up: fb.filter((f) => f.rating === 'up').length,
            down: fb.filter((f) => f.rating === 'down').length,
        },
    };
}

module.exports = {
    logQuestion,
    logFeedback,
    recentQuestions,
    unansweredQuestions,
    recentFeedback,
    summary,
    QUESTION_LOG,
    FEEDBACK_LOG,
};
