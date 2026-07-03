const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const request = require('supertest');

const AUTH_PATH = path.join(__dirname, '..', 'private', 'auth.json');
let originalAuthFileBytes = null;

// These tests exercise the real login/session/password-change flow against the real
// Backend/private/auth.json file. To avoid touching the operator's actual staff/admin
// passwords, the original file bytes are snapshotted before any test runs and restored
// verbatim afterward, regardless of pass/fail.
before(() => {
    originalAuthFileBytes = fs.readFileSync(AUTH_PATH);
});

after(() => {
    if (originalAuthFileBytes) {
        fs.writeFileSync(AUTH_PATH, originalAuthFileBytes);
    }
});

// express-rate-limit's default key is the client IP, and routes/auth.js reuses a single
// limiter instance across BOTH /staff-login and /admin-login. Re-requiring the router
// module (after clearing the require cache) gives each test group its own limiter
// instance, so tests don't silently exhaust each other's 5-attempts/minute budget.
function freshAuthApp() {
    delete require.cache[require.resolve('../routes/auth')];
    const authRoutes = require('../routes/auth');
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
    app.use('/api/auth', authRoutes);
    return app;
}

test('GET /session with no prior login reports public tier', async () => {
    const app = freshAuthApp();
    const res = await request(app).get('/api/auth/session');
    assert.equal(res.status, 200);
    assert.equal(res.body.tier, 'public');
});

test('POST /staff-login rejects an empty password with 400', async () => {
    const app = freshAuthApp();
    const res = await request(app).post('/api/auth/staff-login').send({ password: '' });
    assert.equal(res.status, 400);
});

test('POST /staff-login rejects a wrong password with 401', async () => {
    const app = freshAuthApp();
    const res = await request(app).post('/api/auth/staff-login').send({ password: 'definitely-not-it' });
    assert.equal(res.status, 401);
});

test('correct staff password logs in, persists tier across requests, and logout clears it', async () => {
    const authStore = require('../services/authStore');
    authStore.setStaffPassword('unit-test-staff-pw');

    const app = freshAuthApp();
    const agent = request.agent(app);

    const login = await agent.post('/api/auth/staff-login').send({ password: 'unit-test-staff-pw' });
    assert.equal(login.status, 200);
    assert.equal(login.body.tier, 'staff');

    const session = await agent.get('/api/auth/session');
    assert.equal(session.body.tier, 'staff');

    const logout = await agent.post('/api/auth/logout');
    assert.equal(logout.status, 200);

    const sessionAfter = await agent.get('/api/auth/session');
    assert.equal(sessionAfter.body.tier, 'public');
});

test('admin-gated password-change routes reject non-admin tiers with 403', async () => {
    const authStore = require('../services/authStore');
    authStore.setStaffPassword('unit-test-staff-pw-2');

    const app = freshAuthApp();
    const agent = request.agent(app);
    await agent.post('/api/auth/staff-login').send({ password: 'unit-test-staff-pw-2' });

    const res = await agent.post('/api/auth/change-staff-password').send({ newPassword: 'whatever123' });
    assert.equal(res.status, 403);
});

test('admin can rotate the staff password, and the new password actually takes effect', async () => {
    const authStore = require('../services/authStore');
    authStore.setAdminPassword('unit-test-admin-pw');

    const app = freshAuthApp();
    const agent = request.agent(app);
    const adminLogin = await agent.post('/api/auth/admin-login').send({ password: 'unit-test-admin-pw' });
    assert.equal(adminLogin.status, 200);

    const change = await agent.post('/api/auth/change-staff-password').send({ newPassword: 'brand-new-staff-pw' });
    assert.equal(change.status, 200);
    assert.equal(authStore.verifyStaffPassword('brand-new-staff-pw'), true);
    assert.equal(authStore.verifyStaffPassword('unit-test-staff-pw-2'), false);
});

test('rejects a too-short new password on rotation (validation, not just auth gate)', async () => {
    const authStore = require('../services/authStore');
    authStore.setAdminPassword('unit-test-admin-pw-2');

    const app = freshAuthApp();
    const agent = request.agent(app);
    await agent.post('/api/auth/admin-login').send({ password: 'unit-test-admin-pw-2' });

    const res = await agent.post('/api/auth/change-staff-password').send({ newPassword: 'abc' });
    assert.equal(res.status, 400);
});

test('rate limiter returns 429 on the 6th login attempt within a minute (defect: unbounded login attempts)', async () => {
    const app = freshAuthApp();
    const attempts = [];
    for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app).post('/api/auth/staff-login').send({ password: 'wrong' });
        attempts.push(res.status);
    }
    assert.deepEqual(attempts.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(attempts[5], 429);
});
