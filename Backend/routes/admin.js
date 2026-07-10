const express = require('express');
const fs = require('fs');
const env = require('../config/env');
const { requireTier } = require('../middleware/requireTier');
const { ingestManual } = require('../scripts/ingest');
const searchManual = require('../services/searchManual');
const analyticsStore = require('../services/analyticsStore');
const reservationStore = require('../services/reservationStore');

const router = express.Router();

// Every route here is admin-only. This is the self-improvement surface: edit the manual, push
// the change into the vector store, and see what people are asking (especially what the bot
// couldn't answer) — the loop that turns a decent bot into a good one without a developer.
router.use(requireTier('admin'));

const MAX_MANUAL_BYTES = 500 * 1024; // generous ceiling; the current manual is ~10KB

// Serialize re-ingests: resetCollection() deletes and recreates the collection, so two
// overlapping runs would corrupt each other. This simple in-process flag is enough for a
// single-instance deployment.
let reingestInFlight = false;

router.get('/manual', (req, res) => {
    if (!env.hasManual()) {
        return res.json({ text: '', exists: false });
    }
    try {
        const text = fs.readFileSync(env.MANUAL_PATH, 'utf8');
        res.json({ text, exists: true, bytes: Buffer.byteLength(text) });
    } catch (error) {
        console.error('admin manual read error:', error.message);
        res.status(500).json({ error: 'Could not read the manual file' });
    }
});

router.put('/manual', (req, res) => {
    const text = (req.body || {}).text;
    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Manual text is required and cannot be empty' });
    }
    if (Buffer.byteLength(text) > MAX_MANUAL_BYTES) {
        return res.status(413).json({ error: `Manual must be under ${MAX_MANUAL_BYTES} bytes` });
    }
    try {
        env.ensurePrivateDir();
        fs.writeFileSync(env.MANUAL_PATH, text);
        // Saving does NOT auto-reingest — the admin reviews, then triggers /reingest explicitly,
        // so a typo save doesn't immediately reshape what the bot retrieves.
        res.json({ ok: true, bytes: Buffer.byteLength(text), note: 'Saved. Run POST /api/admin/reingest to rebuild the search index.' });
    } catch (error) {
        console.error('admin manual write error:', error.message);
        res.status(500).json({ error: 'Could not save the manual file' });
    }
});

router.post('/reingest', async (req, res) => {
    if (reingestInFlight) {
        return res.status(409).json({ error: 'A re-ingest is already running. Please wait for it to finish.' });
    }
    reingestInFlight = true;
    try {
        const stats = await ingestManual({ log: () => {} });
        searchManual.refreshKeywordIndex(); // rebuild the BM25 index against the new chunks
        res.json({ ok: true, ...stats });
    } catch (error) {
        console.error('admin reingest error:', error.message);
        res.status(500).json({ error: `Re-ingest failed: ${error.message}` });
    } finally {
        reingestInFlight = false;
    }
});

router.get('/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({
        summary: analyticsStore.summary(),
        unanswered: analyticsStore.unansweredQuestions(limit),
        recent: analyticsStore.recentQuestions(limit),
    });
});

router.get('/feedback', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({ feedback: analyticsStore.recentFeedback(limit) });
});

router.get('/reservations', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({ recent: reservationStore.recentReservations(limit) });
});

module.exports = router;
