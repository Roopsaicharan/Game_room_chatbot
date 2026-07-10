const { applicableStepsWithValues } = require('./fillHelpers');

// Exact field `name` attributes for the 12 core fields, confirmed by an earlier authorized,
// read-only scrape of the real form (never a submit) - safe to rely on directly. The 5
// House-Rental-branch fields (addons/openOrClosed/paymentForm/servingFood/taxExempt) were only
// observed via screenshots during that session, not scraped at the DOM level, so they fall back
// to a generic question-text match below - verify both against the real form with
// `npm run reservation:probe` (headed, dry-run) before ever setting RESERVATION_ALLOW_REAL_SUBMIT.
const QID_MAP = {
    personName: 'QR~QID1~TEXT',
    contactEmail: 'QR~QID6~TEXT',
    contactPhone: 'QR~QID7~TEXT',
    affiliation: 'QR~QID32',
    orgName: 'QR~QID4~TEXT',
    requestType: 'QR~QID5',
    requestedDate: 'QR~QID9~TEXT',
    startTime: 'QR~QID10~TEXT',
    endTime: 'QR~QID11~TEXT',
    alternateDate: 'QR~QID63~TEXT',
    attendees: 'QR~QID51~TEXT',
    purpose: 'QR~QID54~TEXT',
};

const SELECT_FIELDS = new Set(['affiliation', 'requestType']);

async function fillOneStep(page, step, value) {
    const qidName = QID_MAP[step.id];
    if (qidName) {
        const el = page.locator(`[name="${qidName}"]`);
        if (!(await el.count())) return; // not on the current page (yet)
        if (SELECT_FIELDS.has(step.id)) {
            await el.selectOption({ label: value });
        } else {
            await el.fill(String(value));
        }
        return;
    }

    // Fallback for the un-scraped House Rental branch fields: match by the question's own
    // container/text, mirroring the same locator style used during the earlier read-only
    // scrape (`.QuestionOuter` containing the question label).
    const container = page.locator('.QuestionOuter', { hasText: step.question }).first();
    if (!(await container.count())) return;
    if (step.type === 'single-choice') {
        await container.getByRole('radio', { name: value, exact: true }).click();
    } else if (step.type === 'multi-choice') {
        for (const label of value) {
            await container.getByRole('checkbox', { name: label, exact: true }).click();
        }
    } else {
        await container.locator('input, textarea').first().fill(String(value));
    }
}

async function fillVisibleQuestions(page, stepsWithValues) {
    for (const { step, value } of stepsWithValues) {
        // Best-effort per field: a field not yet visible on the current page (or already
        // filled and unmounted from an earlier one) shouldn't abort the whole run.
        await fillOneStep(page, step, value).catch(() => {});
    }
}

const MAX_PAGES = 15;

async function fillAndAdvance(page, stepsWithValues) {
    for (let i = 0; i < MAX_PAGES; i++) {
        await fillVisibleQuestions(page, stepsWithValues);
        const nextButton = page.locator('#NextButton');
        const hasNext = (await nextButton.count()) && (await nextButton.isVisible().catch(() => false));
        if (!hasNext) break;
        await nextButton.click();
        await page.waitForTimeout(800);
    }
}

// The actual safety gate: NEVER click the real form's final Submit/Done button unless
// explicitly allowed. Exported separately so it's unit-testable against a fake `page` stub
// with no real browser (see test/reservationSubmitter.safetyGate.test.js).
async function maybeClickSubmit(page, { allowRealSubmit }) {
    const submitButton = page.getByRole('button', { name: /submit|done/i });
    if (!allowRealSubmit) {
        return { ok: true, submitted: false, dryRun: true };
    }
    await submitButton.click();
    return { ok: true, submitted: true, dryRun: false };
}

async function submit(page, payload, { allowRealSubmit }) {
    const stepsWithValues = applicableStepsWithValues(payload);
    await fillAndAdvance(page, stepsWithValues);
    return maybeClickSubmit(page, { allowRealSubmit });
}

module.exports = { submit, maybeClickSubmit, QID_MAP };
