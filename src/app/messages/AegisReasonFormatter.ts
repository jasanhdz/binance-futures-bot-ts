const REASON_LABELS: Record<string, string> = {
    insufficient_recent_model_agreement: 'Sin acuerdo suficiente entre modelos recientes',
    raw_recent_long_agreement_2_of_3: 'Acuerdo LONG reciente 2/3',
    raw_recent_short_agreement_2_of_3: 'Acuerdo SHORT reciente 2/3',
    short_disabled_in_turbo_v010: 'SHORT detectado, pero deshabilitado por configuración',
    stale_turbo_snapshot: 'Snapshot Turbo desactualizado',
    turbo_score_below_threshold: 'Score por debajo del threshold',
    aegis_turbo_yaml_disabled: 'Aegis Turbo deshabilitado en YAML',
    aegis_live_disabled: 'Live deshabilitado por variable de entorno',
    daily_loss_stop_reached: 'Límite de pérdida diaria alcanzado',
    position_already_open: 'Ya existe una posición abierta',
    allowed_aegis_turbo_micro_live: 'Señal aprobada por gate Aegis Turbo',
    regime_context_available: 'Contexto de régimen disponible',
    regime_context_insufficient_data: 'Contexto de régimen sin datos suficientes',
    momentum_pattern_detected: 'Patrón Momentum Ride detectado',
    momentum_shadow_allow: 'Momentum Ride permitiría en shadow',
    momentum_shadow_deny: 'Momentum Ride bloquearía en shadow',
    momentum_regime_not_confirmed: 'Momentum Ride sin confirmación de régimen',
    momentum_turbo_not_confirmed: 'Momentum Ride sin confirmación Turbo',
    momentum_turbo_confirmed: 'Momentum Ride confirmado por Turbo',
    momentum_turbo_contradict: 'Momentum Ride contradicho por Turbo',
    momentum_side_contradict: 'Momentum Ride contradice el lado solicitado',
    momentum_btc_eth_contradict: 'Momentum Ride contradicho por BTC/ETH',
    momentum_btc_eth_not_confirmed: 'Momentum Ride sin confirmación BTC/ETH',
    momentum_tail_risk_high: 'Momentum Ride con tail risk alto',
    momentum_safety_cap_exceeded: 'Momentum Ride bloqueado por safety cap',
    momentum_override_reserved_not_active: 'Override Momentum Ride reservado, no activo',
    long_risk_probe_long_critical: 'Probe LONG bloqueado por LongRisk CRITICAL: EntryQuality insuficiente + EventRisk/CleanEntry débil + régimen/contexto no confirma'
};

function compactReasonKey(reason: string): string {
    return reason.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeReasonKey(reason: string): string {
    return reason
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/([a-zA-Z])(\d)/g, '$1_$2')
        .replace(/(\d)([a-zA-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase();
}

function humanizeUnknownReason(reason: string): string {
    const normalized = normalizeReasonKey(reason);
    if (!normalized) return 'Aegis Turbo';

    const phrase = normalized
        .replace(/\blong\b/g, 'LONG')
        .replace(/\bshort\b/g, 'SHORT')
        .replace(/\btp\b/g, 'TP')
        .replace(/\bsl\b/g, 'SL')
        .split('_')
        .join(' ');

    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function formatAegisReason(reason?: string): string {
    if (!reason || !reason.trim()) return 'Aegis Turbo';

    const normalized = normalizeReasonKey(reason);
    if (REASON_LABELS[normalized]) return REASON_LABELS[normalized];

    const compact = compactReasonKey(reason);
    const matched = Object.entries(REASON_LABELS).find(([key]) => compactReasonKey(key) === compact);
    if (matched) return matched[1];

    const rawAgreement = compact.match(/^rawrecent(long|short)agreement(\d+)of(\d+)$/);
    if (rawAgreement) {
        return `Acuerdo ${rawAgreement[1].toUpperCase()} reciente ${rawAgreement[2]}/${rawAgreement[3]}`;
    }

    return humanizeUnknownReason(reason);
}
