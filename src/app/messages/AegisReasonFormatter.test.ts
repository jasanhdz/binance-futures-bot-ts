import { describe, expect, it } from 'vitest';
import { formatAegisReason } from './AegisReasonFormatter';

describe('formatAegisReason', () => {
    it('formats insufficient recent model agreement', () => {
        expect(formatAegisReason('insufficient_recent_model_agreement')).toBe('Sin acuerdo suficiente entre modelos recientes');
    });

    it('formats compact long agreement', () => {
        expect(formatAegisReason('rawrecentlongagreement2of3')).toBe('Acuerdo LONG reciente 2/3');
    });

    it('formats compact short agreement', () => {
        expect(formatAegisReason('rawrecentshortagreement2of3')).toBe('Acuerdo SHORT reciente 2/3');
    });

    it('formats short disabled reason', () => {
        expect(formatAegisReason('short_disabled_in_turbo_v010')).toBe('SHORT detectado, pero deshabilitado por configuración');
    });

    it('formats operational gate reasons', () => {
        expect(formatAegisReason('aegis_turbo_yaml_disabled')).toBe('Aegis Turbo deshabilitado en YAML');
        expect(formatAegisReason('aegis_live_disabled')).toBe('Live deshabilitado por variable de entorno');
        expect(formatAegisReason('daily_loss_stop_reached')).toBe('Límite de pérdida diaria alcanzado');
        expect(formatAegisReason('position_already_open')).toBe('Ya existe una posición abierta');
    });
});
