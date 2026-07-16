const { test } = require('node:test');
const assert = require('node:assert/strict');
const qualtricsAdapter = require('../services/reservationSubmitter/qualtricsAdapter');
const reservationFlow = require('../services/reservationFlow');

// Proves the Qualtrics fill pipeline maps a completed reservation payload onto the form's fields
// correctly — WITHOUT any real browser or network. A fake `page` records every field the adapter
// tried to fill so we can assert coverage, and confirms the safety gate leaves the final Submit
// UNCLICKED in the default (dry-run) mode. This is the "build the pipeline and make sure it works,
// but don't touch the real Qualtrics form" check: everything here is in-memory.
//
// It also guards the recent flow changes: orgName is always submitted (auto "N/A" for a solo
// student) and paymentForm/servingFood/taxExempt now apply to every request type — the adapter
// must fill all of them, since the real form marks them required.

function buildPayload(answers) {
    let { state } = reservationFlow.start();
    for (const a of answers) {
        const r = reservationFlow.handleAnswer(state, a);
        if (r.readyToSubmit) break;
        state = r.state;
    }
    return reservationFlow.buildSubmissionPayload(state.answers);
}

// A fake Playwright `page` that records fills instead of driving a browser. Every field is
// reported "present" (count 1) so the adapter attempts to fill it; #NextButton reports absent so
// fillAndAdvance stops after one pass.
function recordingPage() {
    const filledByName = {};      // [name="QR~..."] text fills / selects
    const fallbackFilled = {};    // .QuestionOuter (branch fields) by question text
    let submitClicked = false;

    function nameLocator(name) {
        return {
            count: async () => 1,
            fill: async (v) => { filledByName[name] = { type: 'fill', value: v }; },
            selectOption: async (opt) => { filledByName[name] = { type: 'select', value: opt.label }; },
        };
    }
    function questionContainer(hasText) {
        return {
            count: async () => 1,
            getByRole: (role, opts) => ({ click: async () => { fallbackFilled[hasText] = { role, value: opts && opts.name }; } }),
            locator: () => ({ first: () => ({ fill: async (v) => { fallbackFilled[hasText] = { role: 'text', value: v }; } }) }),
        };
    }
    const page = {
        locator: (sel, opts) => {
            if (typeof sel === 'string' && sel.startsWith('[name="')) return nameLocator(sel.slice(7, -2));
            if (sel === '.QuestionOuter') return { first: () => questionContainer(opts && opts.hasText) };
            if (sel === '#NextButton') return { count: async () => 0, isVisible: async () => false, click: async () => {} };
            return { count: async () => 0, first: () => ({ count: async () => 0 }) };
        },
        getByRole: () => ({ click: async () => { submitClicked = true; } }),
        waitForTimeout: async () => {},
    };
    return { page, filledByName, fallbackFilled, submitClicked: () => submitClicked };
}

test('qualtrics pipeline fills every applicable field for a solo-student House Rental and does NOT submit in dry-run', async () => {
    // Solo UF student (affiliation 2) -> orgName auto "N/A"; House Rental exercises the branch fields too.
    const payload = buildPayload([
        'Jane Solo', 'jane@ufl.edu', '352-123-4567', '2', '1',
        '12/31/2099', '3:00 PM', '5:00 PM', 'none', '40', 'Birthday party',
        '1', '2', '2', '2', '2',
    ]);
    const rec = recordingPage();
    const result = await qualtricsAdapter.submit(rec.page, payload, { allowRealSubmit: false });

    // Safety gate: never clicks the real Submit in dry-run.
    assert.equal(rec.submitClicked(), false);
    assert.deepEqual(result, { ok: true, submitted: false, dryRun: true });

    // All 12 core fields (by QID) were filled, including the auto "N/A" org name.
    const f = rec.filledByName;
    assert.equal(f['QR~QID1~TEXT'].value, 'Jane Solo');
    assert.equal(f['QR~QID4~TEXT'].value, 'N/A', 'orgName auto-fills N/A for a solo student');
    assert.equal(f['QR~QID32'].value, 'UF Student (not with an organization)'); // affiliation (select)
    assert.equal(f['QR~QID5'].value, 'House Rental');                            // requestType (select)
    assert.equal(f['QR~QID51~TEXT'].value, '40');                               // attendees

    // Branch/logistics fields go through the text-matched fallback.
    const fb = rec.fallbackFilled;
    assert.ok(fb['Form of Payment'], 'payment filled via fallback');
    assert.ok(fb['Do you plan on serving food?'], 'serving food filled via fallback');
    assert.ok(fb['Is your organization/group tax-exempt?'], 'tax-exempt filled via fallback');
});

test('qualtrics pipeline fills payment/food/tax for a NON-House-Rental request too (required for all types)', async () => {
    // Lane Reservation Only (affiliation 1 -> orgName asked). No House-Rental-only add-ons.
    const payload = buildPayload([
        'Org Lead', 'org@ufl.edu', '352-123-4567', '1', 'Chess Club', '4',
        '01/15/2027', '2:00 PM', '4:00 PM', 'none', '18', 'Club night',
        '2', '2', '2',
    ]);
    const rec = recordingPage();
    await qualtricsAdapter.submit(rec.page, payload, { allowRealSubmit: false });

    assert.equal(rec.filledByName['QR~QID4~TEXT'].value, 'Chess Club');
    assert.equal(rec.filledByName['QR~QID5'].value, 'Lane Reservation Only');
    const fb = rec.fallbackFilled;
    assert.ok(fb['Form of Payment'], 'payment filled for a lane reservation');
    assert.ok(fb['Do you plan on serving food?'], 'serving food filled for a lane reservation');
    assert.ok(fb['Is your organization/group tax-exempt?'], 'tax-exempt filled for a lane reservation');
    assert.equal(rec.submitClicked(), false);
});
