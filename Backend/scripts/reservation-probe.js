#!/usr/bin/env node
// Manual dev script (not part of `npm test`): runs a REAL, headed Playwright browser against
// RESERVATION_FORM_URL with a fixed sample House Rental payload, so a human can visually confirm
// every field lands correctly before trusting the automation. Mirrors complex-probe.js's role
// as a manual inspection tool, not a pass/fail check.
//
//   npm run reservation:probe
//
// Respects RESERVATION_ALLOW_REAL_SUBMIT exactly like the real chat flow does - leave it unset
// (the default) to fill every field and stop before the final Submit/Done click (dry run); only
// set it to the literal string "true" once you're confident, and ideally only ever against the
// google-forms provider until UF staff have signed off on pointing this at the real form.

const { chromium } = require('playwright');
const env = require('../config/env');
const googleFormsAdapter = require('../services/reservationSubmitter/googleFormsAdapter');
const qualtricsAdapter = require('../services/reservationSubmitter/qualtricsAdapter');

const ADAPTERS = { 'google-forms': googleFormsAdapter, qualtrics: qualtricsAdapter };

const SAMPLE_PAYLOAD = {
    personName: 'Test Automated Probe',
    contactEmail: 'test-probe@ufl.edu',
    contactPhone: '352-000-0000',
    affiliation: 'UF Student (not with an organization)',
    orgName: 'Test Organization',
    requestType: 'House Rental',
    requestedDate: '12/31/2099',
    startTime: '3:00 PM',
    endTime: '5:00 PM',
    alternateDate: null,
    attendees: 40,
    purpose: 'Automated probe run - please ignore',
    addons: ['Tables (6-ft foldable ones)'],
    openOrClosed: 'Closed',
    paymentForm: 'Onsite (check/card)',
    servingFood: 'No',
    taxExempt: 'No',
};

(async () => {
    if (!env.hasReservationFormUrl()) {
        console.error('RESERVATION_FORM_URL is not set in .env - nothing to probe against.');
        process.exit(1);
    }
    const provider = env.RESERVATION_FORM_PROVIDER;
    const adapter = ADAPTERS[provider];
    if (!adapter) {
        console.error(`Unknown RESERVATION_FORM_PROVIDER: ${provider}`);
        process.exit(1);
    }

    console.log(`Probing provider=${provider} url=${env.RESERVATION_FORM_URL}`);
    console.log(env.RESERVATION_ALLOW_REAL_SUBMIT
        ? 'RESERVATION_ALLOW_REAL_SUBMIT=true - this WILL click the final Submit/Done button.'
        : 'RESERVATION_ALLOW_REAL_SUBMIT is not "true" - will fill every field and stop before the final Submit/Done click (dry run).');

    const browser = await chromium.launch({ headless: false, slowMo: 150 });
    try {
        const page = await browser.newPage();
        await page.goto(env.RESERVATION_FORM_URL, { waitUntil: 'domcontentloaded' });
        const result = await adapter.submit(page, SAMPLE_PAYLOAD, { allowRealSubmit: env.RESERVATION_ALLOW_REAL_SUBMIT });
        console.log('Result:', result);
        console.log('Leaving the browser open for 15s so you can visually inspect the final page...');
        await page.waitForTimeout(15000);
    } catch (error) {
        console.error('Probe failed:', error.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
