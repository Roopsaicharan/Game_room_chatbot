// Ordered privilege ladder. supervisor now sits ABOVE staff (its own content tier), and admin
// above supervisor. A higher-ranked role satisfies any lower-ranked requireTier() gate.
const TIER_RANK = { public: 0, staff: 1, supervisor: 2, admin: 3 };

function requireTier(minTier) {
    return (req, res, next) => {
        const tier = req.session?.tier || 'public';
        if ((TIER_RANK[tier] ?? 0) < TIER_RANK[minTier]) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

module.exports = { requireTier, TIER_RANK };
