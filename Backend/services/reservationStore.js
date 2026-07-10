const fs = require('fs');
const path = require('path');
const env = require('../config/env');

// Append-only log of reservation-flow submission attempts, mirroring analyticsStore.js's
// pattern. Logged regardless of whether the automated form-fill succeeded, so a Playwright
// failure never silently loses a visitor's collected answers — staff can still act on the log.
const RESERVATION_LOG = path.join(env.PRIVATE_DIR, 'reservations.jsonl');

function appendLine(file, obj) {
    try {
        env.ensurePrivateDir();
        fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (error) {
        console.warn('reservationStore append failed:', error.message);
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
        console.warn('reservationStore read failed:', error.message);
        return [];
    }
}

function logSubmission({ role, answers, submitted, dryRun, provider, error }) {
    appendLine(RESERVATION_LOG, {
        at: new Date().toISOString(),
        role: role || 'public',
        provider: provider || null,
        submitted: Boolean(submitted),
        dryRun: Boolean(dryRun),
        error: error ? String(error).slice(0, 500) : null,
        answers: answers || {},
    });
}

function recentReservations(limit = 100) {
    return readTail(RESERVATION_LOG, limit);
}

module.exports = {
    logSubmission,
    recentReservations,
    RESERVATION_LOG,
};
