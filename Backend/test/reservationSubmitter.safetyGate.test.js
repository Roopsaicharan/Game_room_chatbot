const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maybeClickSubmit } = require('../services/reservationSubmitter/qualtricsAdapter');

// No real browser anywhere in this file - a fake `page` stub is enough to prove the safety
// gate's click/no-click behavior, which is the entire point of the two-provider design (see
// CLAUDE.md / the reservation-flow plan): the qualtrics adapter must NEVER click the real
// form's final Submit button unless explicitly, deliberately allowed.
function fakePage() {
    let clicked = false;
    return {
        clicked: () => clicked,
        getByRole: () => ({
            click: async () => { clicked = true; },
        }),
    };
}

test('does NOT click submit when allowRealSubmit is false', async () => {
    const page = fakePage();
    const result = await maybeClickSubmit(page, { allowRealSubmit: false });
    assert.equal(page.clicked(), false);
    assert.equal(result.submitted, false);
    assert.equal(result.dryRun, true);
});

test('does NOT click submit when allowRealSubmit is undefined', async () => {
    const page = fakePage();
    const result = await maybeClickSubmit(page, {});
    assert.equal(page.clicked(), false);
    assert.equal(result.dryRun, true);
});

test('DOES click submit when allowRealSubmit is true', async () => {
    const page = fakePage();
    const result = await maybeClickSubmit(page, { allowRealSubmit: true });
    assert.equal(page.clicked(), true);
    assert.equal(result.submitted, true);
    assert.equal(result.dryRun, false);
});
