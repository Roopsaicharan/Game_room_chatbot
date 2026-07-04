const express = require('express');
const rateLimit = require('express-rate-limit');
const authStore = require('../services/authStore');
const { requireTier } = require('../middleware/requireTier');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 72; // bcrypt truncates beyond 72 bytes

const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a minute and try again.' },
});

function regenerateSession(req, tier) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err);
            req.session.tier = tier;
            resolve();
        });
    });
}

router.post('/staff-login', loginLimiter, async (req, res) => {
    const password = String((req.body || {}).password || '');
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }
    if (!authStore.verifyStaffPassword(password)) {
        return res.status(401).json({ error: 'Incorrect password' });
    }
    await regenerateSession(req, 'staff');
    res.json({ tier: 'staff' });
});

router.post('/supervisor-login', loginLimiter, async (req, res) => {
    const password = String((req.body || {}).password || '');
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }
    if (!authStore.verifySupervisorPassword(password)) {
        return res.status(401).json({ error: 'Incorrect password' });
    }
    await regenerateSession(req, 'supervisor');
    res.json({ tier: 'supervisor' });
});

router.post('/admin-login', loginLimiter, async (req, res) => {
    const password = String((req.body || {}).password || '');
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }
    if (!authStore.verifyAdminPassword(password)) {
        return res.status(401).json({ error: 'Incorrect password' });
    }
    await regenerateSession(req, 'admin');
    res.json({ tier: 'admin' });
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ tier: 'public' });
    });
});

router.get('/session', (req, res) => {
    res.json({ tier: req.session?.tier || 'public' });
});

function validateNewPassword(newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
        return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`;
    }
    return null;
}

router.post('/change-staff-password', requireTier('admin'), (req, res) => {
    const newPassword = (req.body || {}).newPassword;
    const validationError = validateNewPassword(newPassword);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    authStore.setStaffPassword(newPassword);
    res.json({ ok: true });
});

router.post('/change-supervisor-password', requireTier('admin'), (req, res) => {
    const newPassword = (req.body || {}).newPassword;
    const validationError = validateNewPassword(newPassword);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    authStore.setSupervisorPassword(newPassword);
    res.json({ ok: true });
});

router.post('/change-admin-password', requireTier('admin'), (req, res) => {
    const newPassword = (req.body || {}).newPassword;
    const validationError = validateNewPassword(newPassword);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    authStore.setAdminPassword(newPassword);
    res.json({ ok: true });
});

module.exports = router;
