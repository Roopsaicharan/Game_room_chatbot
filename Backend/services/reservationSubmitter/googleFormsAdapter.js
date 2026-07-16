const { applicableStepsWithValues } = require('./fillHelpers');

// Our own date fields store MM/DD/YYYY (matching the real Qualtrics form's plain text field).
// Google Forms' native "Date" question type (a browser <input type="date">) rejects that via
// .fill() - it requires ISO YYYY-MM-DD. A form built to match our recipe ("Short answer") won't
// hit this, but form-builder tools (e.g. an AI form generator) can decide a label mentioning
// "MM/DD/YYYY" should be their native Date question type instead - so detect and convert rather
// than assume the question type.
function toIsoDate(mmddyyyy) {
    const [mm, dd, yyyy] = mmddyyyy.split('/');
    return `${yyyy}-${mm}-${dd}`;
}

// Google Forms wraps every question in a div[role="listitem"] whose text includes the question
// title. Only ONE section's listitems are visible at a time (the rest exist in the DOM but are
// hidden), so we re-scan visible containers after every "Next" click rather than assuming a
// fixed page layout - this is a throwaway dev target, so robustness matters more than speed.
async function fillContainer(container, step, value) {
    if (step.type === 'single-choice') {
        await container.getByRole('radio', { name: value, exact: true }).click();
        return;
    }
    if (step.type === 'multi-choice') {
        for (const label of value) {
            await container.getByRole('checkbox', { name: label, exact: true }).click();
        }
        return;
    }
    const input = container.locator('input, textarea').first();
    if (step.type === 'date' && (await input.getAttribute('type')) === 'date') {
        await input.fill(toIsoDate(String(value)));
        return;
    }
    await input.fill(String(value));
}

async function fillVisibleQuestions(page, stepsWithValues) {
    const containers = await page.locator('div[role="listitem"]').all();
    for (const container of containers) {
        const visible = await container.isVisible().catch(() => false);
        if (!visible) continue;
        const text = await container.innerText().catch(() => '');
        const entry = stepsWithValues.find(({ step }) => text.includes(step.formLabelHint || step.question));
        if (!entry) continue;
        await fillContainer(container, entry.step, entry.value).catch((error) => {
            throw new Error(`Failed to fill "${entry.step.question}": ${error.message}`);
        });
    }
}

const MAX_SECTIONS = 15;

// A fingerprint of the currently-visible section (the titles of its visible questions). Used to
// detect a "Next" click that DIDN'T advance — Google Forms keeps you on the same section and
// shows an inline error when a required field is missing or a value doesn't match an option.
async function sectionSignature(page) {
    const parts = [];
    for (const it of await page.locator('div[role="listitem"]').all()) {
        if (await it.isVisible().catch(() => false)) {
            parts.push((await it.innerText().catch(() => '')).slice(0, 50));
        }
    }
    return parts.join('|');
}

// Surfaces Google Forms' inline validation text ("This is a required question", format errors)
// so a stuck form produces an actionable message instead of a generic timeout.
async function collectValidationErrors(page) {
    const texts = await page.locator('div[role="listitem"]').allInnerTexts().catch(() => []);
    const errs = texts
        .map((t) => (t.match(/This is a required question|must be a number|Enter a valid[^\n]*|Invalid[^\n]*/i) || [])[0])
        .filter(Boolean);
    return [...new Set(errs)];
}

async function submit(page, payload) {
    const stepsWithValues = applicableStepsWithValues(payload);
    for (let i = 0; i < MAX_SECTIONS; i++) {
        await fillVisibleQuestions(page, stepsWithValues);

        const submitButton = page.getByRole('button', { name: 'Submit' });
        if (await submitButton.count()) {
            await submitButton.click();
            await page.waitForTimeout(1500);
            // Verify the submission actually went through rather than optimistically reporting
            // success (issue #1: the confirmation must match what really happened). A successful
            // Google Forms submit navigates to /formResponse and shows the confirmation page; if
            // a required field the flow didn't provide is still empty, the form stays put and
            // shows an inline error — surface that instead of a false "submitted".
            const body = await page.locator('body').innerText().catch(() => '');
            const confirmed = /\/formResponse/.test(page.url())
                || /your response has been recorded|response has been recorded/i.test(body);
            if (!confirmed) {
                const errs = await collectValidationErrors(page);
                throw new Error(`Submit was rejected${errs.length ? ` (${errs.join('; ')})` : ''} - the form did not confirm the response.`);
            }
            return { ok: true, submitted: true, dryRun: false };
        }

        const nextButton = page.getByRole('button', { name: 'Next' });
        if (!(await nextButton.count())) {
            throw new Error('Could not find a Next or Submit button - the form structure may not match what this adapter expects.');
        }

        // Click Next, then confirm we actually moved to a new section. If the signature is
        // unchanged, the form rejected this section (a validation error) — fail fast with the
        // reason instead of re-filling and re-clicking until MAX_SECTIONS.
        const before = await sectionSignature(page);
        await nextButton.click();
        await page.waitForTimeout(700);
        if ((await sectionSignature(page)) === before) {
            const errs = await collectValidationErrors(page);
            throw new Error(`Form did not advance past a section${errs.length ? ` (${errs.join('; ')})` : ''} - a required field is likely missing or a value didn't match an option.`);
        }
    }
    throw new Error(`Exceeded ${MAX_SECTIONS} sections without reaching Submit - possible infinite loop.`);
}

module.exports = { submit };
