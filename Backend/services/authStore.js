const fs = require('fs');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

const DEFAULT_PASSWORD = '0000';
const SALT_ROUNDS = 10;

function seedIfMissing() {
    env.ensurePrivateDir();
    if (!fs.existsSync(env.AUTH_PATH)) {
        const hash = bcrypt.hashSync(DEFAULT_PASSWORD, SALT_ROUNDS);
        const data = { staffPasswordHash: hash, adminPasswordHash: hash };
        fs.writeFileSync(env.AUTH_PATH, JSON.stringify(data, null, 2));
        console.warn(`Seeded ${env.AUTH_PATH} with default password "0000" for both staff and admin — change these immediately via the admin panel.`);
    }
}

function readAuth() {
    return JSON.parse(fs.readFileSync(env.AUTH_PATH, 'utf8'));
}

function writeAuth(data) {
    fs.writeFileSync(env.AUTH_PATH, JSON.stringify(data, null, 2));
}

function verifyStaffPassword(password) {
    const { staffPasswordHash } = readAuth();
    return bcrypt.compareSync(password, staffPasswordHash);
}

function verifyAdminPassword(password) {
    const { adminPasswordHash } = readAuth();
    return bcrypt.compareSync(password, adminPasswordHash);
}

function setStaffPassword(newPassword) {
    const data = readAuth();
    data.staffPasswordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
    writeAuth(data);
}

function setAdminPassword(newPassword) {
    const data = readAuth();
    data.adminPasswordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
    writeAuth(data);
}

// Returns which roles are still on the seeded "0000" default, so the server can surface a
// loud startup warning until they're rotated (they must be changed before any real use).
function rolesUsingDefaultPassword() {
    if (!fs.existsSync(env.AUTH_PATH)) return [];
    const data = readAuth();
    const roles = [];
    if (data.staffPasswordHash && bcrypt.compareSync(DEFAULT_PASSWORD, data.staffPasswordHash)) roles.push('staff');
    if (data.adminPasswordHash && bcrypt.compareSync(DEFAULT_PASSWORD, data.adminPasswordHash)) roles.push('admin');
    if (data.supervisorPasswordHash && bcrypt.compareSync(DEFAULT_PASSWORD, data.supervisorPasswordHash)) roles.push('supervisor');
    return roles;
}

module.exports = {
    seedIfMissing,
    verifyStaffPassword,
    verifyAdminPassword,
    setStaffPassword,
    setAdminPassword,
    rolesUsingDefaultPassword,
};
