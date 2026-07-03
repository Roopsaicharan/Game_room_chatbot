const TIER_RANK = { public: 0, staff: 1, supervisor: 1, admin: 2 };

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
