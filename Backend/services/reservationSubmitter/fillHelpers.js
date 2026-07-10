const reservationFlow = require('../reservationFlow');

// Only the fields that actually apply to this submission (branch-aware) AND were actually
// collected (skips the optional fields the visitor left blank), paired with their values —
// shared by both adapters so the "what to fill" logic isn't duplicated per-provider.
function applicableStepsWithValues(payload) {
    return reservationFlow.STEPS
        .filter((step) => step.appliesTo(payload) && payload[step.id] !== undefined && payload[step.id] !== null)
        .map((step) => ({ step, value: payload[step.id] }));
}

module.exports = { applicableStepsWithValues };
