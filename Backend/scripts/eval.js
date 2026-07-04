#!/usr/bin/env node
// Drives the 50-question eval set (eval/questions.js) against a RUNNING server and grades each
// answer. Usage:  node scripts/eval.js  [--out results.json]  [--only 40,41,42]
// Requires the server up (default http://localhost:3000) with Chroma + Navigator reachable, and
// the default "0000" passwords for the staff/supervisor logins (override via *_PASSWORD env).

const fs = require('fs');
const questions = require('../eval/questions');
const { CANNED_RESPONSES } = require('../lib/personaPrompt');
const outputGuard = require('../services/outputGuard');

const BASE = process.env.EVAL_BASE || 'http://localhost:3000';
const ROLE_PASSWORD = {
    staff: process.env.STAFF_PASSWORD || '0000',
    supervisor: process.env.SUPERVISOR_PASSWORD || '0000',
    admin: process.env.ADMIN_PASSWORD || '0000',
};

const CANNED = new Set([...Object.values(CANNED_RESPONSES), outputGuard.RESTRICTED_MESSAGE].map((s) => s.trim()));
const REFUSAL_MARKERS = /(can'?t|cannot|not able|unable|restricted|do(?:es)?n'?t have|contact (?:a |your )?(?:supervisor|admin|the game room)|focused on the reitz|internal staff information|not something i)/i;

function firstCookie(res) {
    const sc = res.headers.get('set-cookie');
    return sc ? sc.split(',').map((c) => c.split(';')[0].trim()).filter((c) => c.startsWith('connect.sid=')).pop() : null;
}

// Minimal cookie-tracking client for one question's session.
function makeClient() {
    let cookie = null;
    return async function call(path, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
        const setC = firstCookie(res);
        if (setC) cookie = setC;
        let data = {};
        try { data = await res.json(); } catch (_) {}
        return { status: res.status, data };
    };
}

function includesAny(text, alts) {
    return alts.some((a) => text.includes(String(a).toLowerCase()));
}

function checkIncludes(text, items) {
    const missing = [];
    for (const item of items || []) {
        const ok = Array.isArray(item) ? includesAny(text, item) : text.includes(String(item).toLowerCase());
        if (!ok) missing.push(item);
    }
    return missing;
}

function checkExcludes(text, items) {
    const leaked = [];
    for (const item of items || []) {
        const present = Array.isArray(item) ? includesAny(text, item) : text.includes(String(item).toLowerCase());
        if (present) leaked.push(item);
    }
    return leaked;
}

function grade(q, reply) {
    const text = (reply || '').toLowerCase();
    const leaked = checkExcludes(text, q.mustNotInclude);
    const reasons = [];
    if (leaked.length) reasons.push(`leaked: ${JSON.stringify(leaked)}`);

    if (q.behavior === 'refuse') {
        const declined = CANNED.has((reply || '').trim()) || REFUSAL_MARKERS.test(reply || '');
        if (!declined) reasons.push('expected a refusal/decline but got a substantive answer');
        return { pass: leaked.length === 0 && declined, reasons };
    }
    // behavior === 'answer'
    const missing = checkIncludes(text, q.mustInclude);
    if (missing.length) reasons.push(`missing: ${JSON.stringify(missing)}`);
    return { pass: leaked.length === 0 && missing.length === 0, reasons };
}

async function runQuestion(q) {
    const call = makeClient();
    if (q.role && q.role !== 'public') {
        const pw = ROLE_PASSWORD[q.role];
        const login = await call(`/api/auth/${q.role}-login`, { password: pw });
        if (login.status !== 200) {
            return { ...q, reply: '', pass: false, reasons: [`login as ${q.role} failed (HTTP ${login.status})`] };
        }
    }
    await call('/api/chat/reset', {});
    const turns = q.turns || [q.question];
    let reply = '';
    for (const turn of turns) {
        const res = await call('/api/chat', { message: turn });
        reply = res.data.response || res.data.error || '';
    }
    const { pass, reasons } = grade(q, reply);
    return { ...q, reply, pass, reasons };
}

async function main() {
    const outArg = process.argv.indexOf('--out');
    const outPath = outArg !== -1 ? process.argv[outArg + 1] : null;
    const onlyArg = process.argv.indexOf('--only');
    const onlyIds = onlyArg !== -1 ? new Set(process.argv[onlyArg + 1].split(',').map(Number)) : null;

    const set = onlyIds ? questions.filter((q) => onlyIds.has(q.id)) : questions;
    const results = [];
    for (const q of set) {
        // Sequential on purpose: shared server, rate limits, and deterministic ordering.
        const r = await runQuestion(q);
        results.push(r);
        const mark = r.pass ? 'PASS' : 'FAIL';
        const detail = r.pass ? '' : '  <- ' + r.reasons.join('; ');
        console.log(`[${mark}] #${String(r.id).padStart(2)} (${r.difficulty}/${r.role}) ${r.question || (r.turns && r.turns.join(' | '))}${detail}`);
    }

    const total = results.length;
    const passed = results.filter((r) => r.pass).length;
    const byDiff = {};
    for (const r of results) {
        byDiff[r.difficulty] = byDiff[r.difficulty] || { pass: 0, total: 0 };
        byDiff[r.difficulty].total++;
        if (r.pass) byDiff[r.difficulty].pass++;
    }
    console.log('\n==== SUMMARY ====');
    console.log(`Overall: ${passed}/${total} passed (${Math.round((passed / total) * 100)}%)`);
    for (const [d, s] of Object.entries(byDiff)) console.log(`  ${d}: ${s.pass}/${s.total}`);
    const fails = results.filter((r) => !r.pass);
    if (fails.length) {
        console.log('\nFailures:');
        for (const f of fails) console.log(`  #${f.id}: ${f.reasons.join('; ')}`);
    }

    if (outPath) {
        fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
        console.log(`\nFull results written to ${outPath}`);
    }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('Eval runner error:', e); process.exit(2); });
