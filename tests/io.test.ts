import {
    buildExportPayload,
    serializeExport,
    validateExport,
    parseExport,
    EXPORT_FORMAT,
} from '../src/io';
import { DEFAULT_SETTINGS } from '../src/types';

describe('buildExportPayload', () => {
    it('produces a valid payload with normalized settings', () => {
        const payload = buildExportPayload({ acpCommand: 'dsh' }, []);
        expect(payload.format).toBe(EXPORT_FORMAT);
        expect(payload.exportVersion).toBe(1);
        expect(payload.settings.acpCommand).toBe('dsh');
        expect(payload.conversations).toEqual([]);
        expect(payload.exportedAt).toBeGreaterThan(0);
    });

    it('drops invalid conversations', () => {
        const payload = buildExportPayload({}, [{ id: 'ok' }, null as any, 'x' as any]);
        expect(payload.conversations.length).toBe(1);
        expect(payload.conversations[0].id).toBe('ok');
    });
});

describe('serialize/parse round trip', () => {
    it('round-trips a payload', () => {
        const payload = buildExportPayload({ acpCommand: 'dsh --profile acp', maxConversations: 7 }, [{ id: 'c1', title: 'T', sessionId: '', messages: [], createdAt: 1, updatedAt: 1 }]);
        const parsed = parseExport(serializeExport(payload));
        expect(parsed).not.toBeNull();
        expect(parsed!.format).toBe(EXPORT_FORMAT);
        expect(parsed!.settings.acpCommand).toBe('dsh --profile acp');
        expect(parsed!.settings.maxConversations).toBe(7);
        expect(parsed!.conversations[0].id).toBe('c1');
    });
});

describe('validateExport', () => {
    it('rejects wrong format', () => {
        expect(validateExport({ format: 'other' })).toBeNull();
    });
    it('rejects wrong exportVersion', () => {
        expect(validateExport({ format: EXPORT_FORMAT, exportVersion: 99 })).toBeNull();
    });
    it('rejects non-object', () => {
        expect(validateExport('x')).toBeNull();
        expect(validateExport(null)).toBeNull();
    });
    it('accepts valid export and fills defaults', () => {
        const parsed = validateExport({ format: EXPORT_FORMAT, exportVersion: 1, dataVersion: 1 });
        expect(parsed).not.toBeNull();
        expect(parsed!.settings).toEqual(DEFAULT_SETTINGS);
        expect(parsed!.conversations).toEqual([]);
    });
});

describe('parseExport', () => {
    it('returns null for invalid JSON', () => {
        expect(parseExport('not json')).toBeNull();
    });
    it('returns null for valid JSON but invalid structure', () => {
        expect(parseExport('{"a":1}')).toBeNull();
    });
});
