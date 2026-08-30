import { Side } from '../../../core/types';

export type AegisPhaseOMetadata = {
  isPhaseO: boolean;
  side: Side | null;
  entryEnabled: boolean;
  avoidOnly: boolean;
  modelFamily?: string;
  symbol?: string;
  sourcePath: string;
  raw?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function normalizeSideValue(value: unknown): Side | null {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'SHORT' || normalized === 'SELL') return 'SHORT';
  if (normalized === 'LONG' || normalized === 'BUY') return 'LONG';
  return null;
}

function isTruthyPhaseOFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 'PHASE_O' || value === 'phase_o';
}

function hasPhaseOModelPath(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') return value.toLowerCase().includes('phase_o');
  if (Array.isArray(value)) return value.some(hasPhaseOModelPath);
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).some(hasPhaseOModelPath);
}

export function extractAegisPhaseOMetadata(
  signalOrPrediction: unknown,
  fallbackSide?: Side,
): AegisPhaseOMetadata | null {
  const root = asRecord(signalOrPrediction);
  if (!root) return null;
  const candidates: Array<{
    path: string;
    container?: Record<string, any>;
    phase?: Record<string, any>;
  }> = [
    {
      path: 'signal.metadata.aegis.turbo.phase_o',
      container: asRecord(root.metadata)?.aegis?.turbo,
      phase: asRecord(asRecord(root.metadata)?.aegis?.turbo?.phase_o),
    },
    {
      path: 'signal.metadata.aegis.turbo.raw.phase_o',
      container: asRecord(root.metadata)?.aegis?.turbo,
      phase: asRecord(asRecord(root.metadata)?.aegis?.turbo?.raw?.phase_o),
    },
    {
      path: 'signal.metadata.turbo.phase_o',
      container: asRecord(root.metadata)?.turbo,
      phase: asRecord(asRecord(root.metadata)?.turbo?.phase_o),
    },
    {
      path: 'signal.metadata.turbo.raw.phase_o',
      container: asRecord(root.metadata)?.turbo,
      phase: asRecord(asRecord(root.metadata)?.turbo?.raw?.phase_o),
    },
    {
      path: 'signal.aegis.turbo.phase_o',
      container: asRecord(root.aegis)?.turbo,
      phase: asRecord(asRecord(root.aegis)?.turbo?.phase_o),
    },
    {
      path: 'signal.aegis.turbo.raw.phase_o',
      container: asRecord(root.aegis)?.turbo,
      phase: asRecord(asRecord(root.aegis)?.turbo?.raw?.phase_o),
    },
    {
      path: 'signal.turbo.phase_o',
      container: asRecord(root.turbo),
      phase: asRecord(asRecord(root.turbo)?.phase_o),
    },
    {
      path: 'signal.turbo.raw.phase_o',
      container: asRecord(root.turbo),
      phase: asRecord(asRecord(root.turbo)?.raw?.phase_o),
    },
    {
      path: 'signal.metadata.rawPrediction.aegis.turbo.phase_o',
      container: asRecord(asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo,
      phase: asRecord(asRecord(asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo?.phase_o),
    },
    {
      path: 'signal.metadata.rawPrediction.aegis.turbo.raw.phase_o',
      container: asRecord(asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo,
      phase: asRecord(asRecord(asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo?.raw?.phase_o),
    },
    {
      path: 'signal.metadata.phase_o',
      container: asRecord(root.metadata),
      phase: asRecord(asRecord(root.metadata)?.phase_o),
    },
    { path: 'signal.phase_o', container: root, phase: asRecord(root.phase_o) },
    { path: 'signal.phaseO', container: root, phase: asRecord(root.phaseO) },
    {
      path: 'signal.metadata.phase_o_short_live',
      container: asRecord(root.metadata),
      phase: asRecord(asRecord(root.metadata)?.phase_o_short_live),
    },
  ];

  for (const candidate of candidates) {
    const phase = candidate.phase;
    const container = candidate.container;
    if (!phase && !container) continue;
    const phaseRecord = phase ?? {};
    const isPhaseO =
      isTruthyPhaseOFlag(phaseRecord.phase_o) ||
      isTruthyPhaseOFlag(phaseRecord.phaseO) ||
      isTruthyPhaseOFlag(phaseRecord.is_phase_o) ||
      isTruthyPhaseOFlag(phaseRecord.phase_o_live_enabled) ||
      isTruthyPhaseOFlag(phaseRecord.enabled) ||
      String(phaseRecord.phase_o_live_mode ?? '').toLowerCase().includes('experimental_short') ||
      hasPhaseOModelPath(phaseRecord.phase_o_source_model_paths) ||
      hasPhaseOModelPath(phaseRecord.model_paths) ||
      hasPhaseOModelPath(container?.raw?.model_path) ||
      hasPhaseOModelPath(container?.raw?.model_paths) ||
      hasPhaseOModelPath(container?.model_paths);
    if (!isPhaseO) continue;
    const side =
      normalizeSideValue(phaseRecord.side) ??
      normalizeSideValue(container?.gated?.action) ??
      normalizeSideValue(container?.action) ??
      normalizeSideValue(container?.raw?.action) ??
      fallbackSide ??
      null;
    const symbol =
      String(phaseRecord.symbol ?? container?.symbol ?? root.symbol ?? '').toUpperCase() || undefined;
    const avoidOnly =
      phaseRecord.phase_o_link_avoid_only === true ||
      phaseRecord.link_avoid_only === true ||
      phaseRecord.avoid_only === true ||
      phaseRecord.phase_o_avoid_only === true;
    const entryEnabled =
      phaseRecord.entry_enabled !== false &&
      phaseRecord.entryEnabled !== false &&
      phaseRecord.phase_o_entry_enabled !== false &&
      phaseRecord.allow_orders !== false;
    return {
      isPhaseO,
      side,
      entryEnabled,
      avoidOnly,
      modelFamily:
        String(
          phaseRecord.model_family ?? phaseRecord.modelFamily ?? phaseRecord.phase_o_live_mode ?? '',
        ).trim() || undefined,
      symbol,
      sourcePath: candidate.path,
      raw: phaseRecord,
    };
  }
  return null;
}
