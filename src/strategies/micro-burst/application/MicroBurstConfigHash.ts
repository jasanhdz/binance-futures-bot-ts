import { createHash } from 'node:crypto';
import type { MicroBurstRuntimeConfig } from './MicroBurstRuntimeTypes';

/** Preserve persisted provenance, including present-but-undefined object properties. */
export function microBurstConfigHash(config: MicroBurstRuntimeConfig): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return createHash('sha256').update(stable(config)).digest('hex');
}
