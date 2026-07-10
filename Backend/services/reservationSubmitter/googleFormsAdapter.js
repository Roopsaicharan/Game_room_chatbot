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

async function submit(page, payload) {
    const stepsWithValues = applicableStepsWithValues(payload);
    for (let i = 0; i < MAX_SECTIONS; i++) {
        await fillVisibleQuestions(page, stepsWithValues);

        const submitButton = page.getByRole('button', { name: 'Submit' });
        if (await submitButton.count()) {
            await submitButton.click();
            await page.waitForTimeout(1000);
            return { ok: true, submitted: true, dryRun: false };
        }

        const nextButton = page.getByRole('button', { name: 'Next' });
        if (await nextButton.count()) {
            await nextButton.click();
            await page.waitForTimeout(500);
            continue;
        }

        throw new Error('Could not find a Next or Submit button - the form structure may not match what this adapter expects.');
    }
    throw new Error(`Exceeded ${MAX_SECTIONS} sections without reaching Submit - possible infinite loop.`);
}

module.exports = { submit };
