const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const request = require('supertest');
const authRoutes = require('../routes/auth');

// Proves the actual point of the file-backed session store: two independent Express app
// instances (standing in for "before restart" and "after restart" — they share no JS
// memory) still agree on who's logged in, because the session data lives in files on disk
// rather than in either process's RAM.
//
// This test also mutates the real Backend/private/auth.json (see below) — same shared
// resource auth.integration.test.js touches. Node's test runner runs different test FILES
// concurrently by default, which caused an intermittent real failure here (one file's
// password change landing mid-flight during the other's login attempt). `npm test` now
// runs with --test-concurrency=1 specifically to prevent that; don't drop that flag without
// also fixing the underlying shared-file race.
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameroom-session-test-'));

after(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
});

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(session({
        store: new FileStore({ path: sessionsDir, ttl: 3600, logFn: () => {} }),
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false },
    }));
    app.use('/api/auth', authRoutes);
    return app;
}

test('a session created on one app instance is still valid on a second, independent instance sharing the same file store', async () => {
    const authStore = require('../services/authStore');
    const originalAuthFileBytes = fs.readFileSync(require('../config/env').AUTH_PATH);
    try {
        authStore.setStaffPassword('persistence-test-pw');

        // "Before restart": log in on instance A, capture the raw session cookie.
        const appA = buildApp();
        const loginRes = await request(appA).post('/api/auth/staff-login').send({ password: 'persistence-test-pw' });
        assert.equal(loginRes.status, 200);
        const cookie = loginRes.headers['set-cookie'];
        assert.ok(cookie, 'expected a session cookie to be set');

        // "After restart": a brand-new app instance, zero shared JS memory with instance A,
        // only the same session-file-store directory on disk.
        const appB = buildApp();
        const sessionRes = await request(appB).get('/api/auth/session').set('Cookie', cookie);
        assert.equal(sessionRes.status, 200);
        assert.equal(sessionRes.body.tier, 'staff', 'session should still be recognized as staff after a simulated restart');
    } finally {
        fs.writeFileSync(require('../config/env').AUTH_PATH, originalAuthFileBytes);
    }
});
