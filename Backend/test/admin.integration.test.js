const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const adminRoutes = require('../routes/admin');

// Inject the session tier via a header instead of a real login, so these tests don't touch
// auth.json and never trigger a real re-ingest or manual write (only read-only + validation
// paths are exercised here).
function adminApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { tier: req.headers['x-test-tier'] || 'public' };
        next();
    });
    app.use('/api/admin', adminRoutes);
    return app;
}

test('admin routes reject a public user with 403', async () => {
    const app = adminApp();
    const res = await request(app).get('/api/admin/manual');
    assert.equal(res.status, 403);
});

test('admin routes reject a staff user with 403 (staff is below admin)', async () => {
    const app = adminApp();
    const res = await request(app).get('/api/admin/logs').set('X-Test-Tier', 'staff');
    assert.equal(res.status, 403);
});

test('admin routes reject a supervisor with 403 (supervisor is below admin)', async () => {
    const app = adminApp();
    const res = await request(app).get('/api/admin/manual').set('X-Test-Tier', 'supervisor');
    assert.equal(res.status, 403);
});

test('an admin can read the current manual text', async () => {
    const app = adminApp();
    const res = await request(app).get('/api/admin/manual').set('X-Test-Tier', 'admin');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.text, 'string');
});

test('an admin gets a structured logs response (summary + unanswered + recent)', async () => {
    const app = adminApp();
    const res = await request(app).get('/api/admin/logs').set('X-Test-Tier', 'admin');
    assert.equal(res.status, 200);
    assert.ok(res.body.summary);
    assert.ok(Array.isArray(res.body.unanswered));
    assert.ok(Array.isArray(res.body.recent));
});

test('PUT /manual rejects empty text with 400 before writing anything', async () => {
    const app = adminApp();
    const res = await request(app).put('/api/admin/manual').set('X-Test-Tier', 'admin').send({ text: '   ' });
    assert.equal(res.status, 400);
});
