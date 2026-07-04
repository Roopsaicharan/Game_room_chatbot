const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireTier, TIER_RANK } = require('../middleware/requireTier');

function mockReqRes(tier) {
    const req = { session: tier === undefined ? undefined : { tier } };
    let statusCode = null;
    let jsonBody = null;
    const res = {
        status(code) { statusCode = code; return this; },
        json(body) { jsonBody = body; return this; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return { req, res, next, getStatus: () => statusCode, getJson: () => jsonBody, wasNextCalled: () => nextCalled };
}

test('TIER_RANK ranks tiers as an ordered ladder (public < staff < supervisor < admin)', () => {
    assert.equal(TIER_RANK.public, 0);
    assert.equal(TIER_RANK.staff, 1);
    assert.equal(TIER_RANK.supervisor, 2);
    assert.equal(TIER_RANK.admin, 3);
});

test('no session at all is treated as public and rejected by requireTier("staff")', () => {
    const { req, res, next, getStatus, wasNextCalled } = mockReqRes(undefined);
    requireTier('staff')(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(getStatus(), 403);
});

test('public tier is rejected from a staff-gated route', () => {
    const { req, res, next, getStatus } = mockReqRes('public');
    requireTier('staff')(req, res, next);
    assert.equal(getStatus(), 403);
});

test('staff tier is rejected from an admin-gated route', () => {
    const { req, res, next, getStatus } = mockReqRes('staff');
    requireTier('admin')(req, res, next);
    assert.equal(getStatus(), 403);
});

test('supervisor tier is accepted on a staff-gated route (outranks staff)', () => {
    const { req, res, next, wasNextCalled } = mockReqRes('supervisor');
    requireTier('staff')(req, res, next);
    assert.equal(wasNextCalled(), true);
});

test('supervisor tier is rejected from an admin-gated route (below admin)', () => {
    const { req, res, next, getStatus } = mockReqRes('supervisor');
    requireTier('admin')(req, res, next);
    assert.equal(getStatus(), 403);
});

test('admin tier passes every gate, including a supervisor-gated one', () => {
    const adminOnStaff = mockReqRes('admin');
    requireTier('staff')(adminOnStaff.req, adminOnStaff.res, adminOnStaff.next);
    assert.equal(adminOnStaff.wasNextCalled(), true);

    const adminOnSupervisor = mockReqRes('admin');
    requireTier('supervisor')(adminOnSupervisor.req, adminOnSupervisor.res, adminOnSupervisor.next);
    assert.equal(adminOnSupervisor.wasNextCalled(), true);
});
