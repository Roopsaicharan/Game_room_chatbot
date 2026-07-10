const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');

const env = require('./config/env');
const authStore = require('./services/authStore');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

const app = express();

// Frontend and API are served from this same Express app — no cross-origin access is
// needed, so we deliberately don't enable CORS (smaller attack surface).
app.use(express.json({ limit: '20kb' }));

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

env.ensureSessionsDir();

app.use(session({
    store: new FileStore({
        path: env.SESSIONS_DIR,
        ttl: SESSION_MAX_AGE_MS / 1000,
        // express-session already logs unexpected errors via its own error handling;
        // this store's own console logging on top of that is just noise.
        logFn: () => {},
    }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // Set SESSION_COOKIE_SECURE=true once this is served over HTTPS in production.
        secure: process.env.SESSION_COOKIE_SECURE === 'true',
        maxAge: SESSION_MAX_AGE_MS,
    },
}));

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

app.use('/api/chat', chatRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// Centralized error handler: never leak stack traces / file paths to the client.
// Catches body-parser errors (malformed JSON, oversized payloads) and anything else
// that reaches this point without being handled by a route.
app.use((err, req, res, next) => {
    console.error('Unhandled request error:', err.message);
    if (res.headersSent) {
        return next(err);
    }
    const status = err.status || err.statusCode || 500;
    const messages = {
        400: 'Malformed request body',
        413: 'Request body too large',
    };
    res.status(status).json({ error: messages[status] || 'Something went wrong' });
});

authStore.seedIfMissing();

app.listen(env.PORT, () => {
    console.log(`Server running at http://localhost:${env.PORT}`);

    if (!env.hasApiKey()) {
        console.warn('NAVIGATOR_API_KEY is not configured. The site is available, but chat is disabled.');
    }
    if (!env.hasManual()) {
        console.warn(`No manual found at ${env.MANUAL_PATH}. Manual-based Q&A will be disabled until it's added.`);
    }
    const defaultRoles = authStore.rolesUsingDefaultPassword();
    if (defaultRoles.length > 0) {
        console.warn(`SECURITY: ${defaultRoles.join(' and ')} still using the default "0000" password — rotate immediately via the admin panel before real use.`);
    }
    if (!env.hasReservationFormUrl()) {
        console.warn('RESERVATION_FORM_URL is not configured. The reservation chat flow will collect answers but fail to submit them until it is set.');
    } else if (env.RESERVATION_FORM_PROVIDER === 'qualtrics' && !env.RESERVATION_ALLOW_REAL_SUBMIT) {
        console.warn('RESERVATION_FORM_PROVIDER is "qualtrics" but RESERVATION_ALLOW_REAL_SUBMIT is not "true" — reservation submissions will fill the real form but stop short of clicking Submit (dry run). Only enable this deliberately.');
    } else if (env.RESERVATION_FORM_PROVIDER === 'qualtrics' && env.RESERVATION_ALLOW_REAL_SUBMIT) {
        console.warn('SECURITY: RESERVATION_ALLOW_REAL_SUBMIT is "true" with the qualtrics provider — reservation submissions will be sent to the REAL UF form.');
    }
});
