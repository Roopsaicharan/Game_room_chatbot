const { chromium } = require('playwright');
const env = require('../../config/env');
const googleFormsAdapter = require('./googleFormsAdapter');
const qualtricsAdapter = require('./qualtricsAdapter');

// Providers a reservation submission can target. 'google-forms' is the throwaway dev/test
// target; 'qualtrics' is the real UF form, gated by env.RESERVATION_ALLOW_REAL_SUBMIT inside
// qualtricsAdapter itself (see that file) — never here, so the gate can't be bypassed by a
// caller that skips this dispatcher.
// MAINTENANCE NOTE (Issue #15): BOTH adapters must be maintained moving forward. The Google Forms
// adapter is required for automated test suites and safe local development, preventing spam to the 
// real UF Qualtrics instance. The Qualtrics adapter is used exclusively in production.
const ADAPTERS = {
    'google-forms': googleFormsAdapter,
    qualtrics: qualtricsAdapter,
};

// Cheap misconfiguration guard: catches a copy-pasted wrong URL (e.g. a Qualtrics link left in
// RESERVATION_FORM_URL while RESERVATION_FORM_PROVIDER is still 'google-forms') before ever
// launching a browser against the wrong target.
const HOSTNAME_HINTS = {
    'google-forms': 'docs.google.com',
    qualtrics: 'qualtrics.com',
};

function assertUrlMatchesProvider(provider, url) {
    const hint = HOSTNAME_HINTS[provider];
    if (hint && !url.includes(hint)) {
        throw new Error(`RESERVATION_FORM_URL doesn't look like a ${provider} URL (expected it to contain "${hint}"). Check RESERVATION_FORM_PROVIDER/RESERVATION_FORM_URL in .env.`);
    }
}

// Submits a completed reservation payload against the configured provider. Returns
// { ok, submitted, dryRun, error } — never throws for an adapter-level failure (a submission
// failure should degrade to "we recorded your answers, staff will follow up," not crash the
// chat request), but DOES throw for a configuration error (missing URL, unknown provider),
// since that's a deploy-time mistake that should be loud, not silently swallowed.
async function submitReservation(payload) {
    if (!env.hasReservationFormUrl()) {
        throw new Error('RESERVATION_FORM_URL is not configured');
    }
    const provider = env.RESERVATION_FORM_PROVIDER;
    const adapter = ADAPTERS[provider];
    if (!adapter) {
        throw new Error(`Unknown RESERVATION_FORM_PROVIDER: ${provider}`);
    }
    assertUrlMatchesProvider(provider, env.RESERVATION_FORM_URL);

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(env.RESERVATION_FORM_URL, { waitUntil: 'domcontentloaded' });
        const result = await adapter.submit(page, payload, { allowRealSubmit: env.RESERVATION_ALLOW_REAL_SUBMIT });
        return { provider, ...result };
    } catch (error) {
        return { provider, ok: false, submitted: false, dryRun: false, error: error.message };
    } finally {
        await browser.close();
    }
}

module.exports = { submitReservation, ADAPTERS };
