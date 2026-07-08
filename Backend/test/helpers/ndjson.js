// Shared parsing helper for the /api/chat streaming response body (routes/chat.js's
// startStream/writeEvent protocol) — one JSON object per line. Tests use this instead of
// res.body since the success path is no longer a single JSON document.
function parseNdjsonEvents(rawText) {
    return String(rawText || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function fullText(events) {
    return events.filter((e) => e.type === 'chunk').map((e) => e.text).join('');
}

function doneEvent(events) {
    return events.find((e) => e.type === 'done') || null;
}

module.exports = { parseNdjsonEvents, fullText, doneEvent };
