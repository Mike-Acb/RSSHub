import { describe, expect, test } from 'vitest';

import { mergeUserTimelines } from './routes/twitter/utils';

describe('mergeUserTimelines', () => {
    test('keeps main tweets missing from the replies timeline and prefers detailed duplicates', () => {
        const mainOnly = {
            id_str: '3',
            created_at: 'Wed, 12 Aug 2026 03:17:03 GMT',
            full_text: 'main timeline only',
        };
        const mainDuplicate = {
            id_str: '2',
            created_at: 'Wed, 12 Aug 2026 02:00:00 GMT',
            full_text: 'main timeline version',
        };
        const detailedDuplicate = {
            id_str: '2',
            created_at: 'Wed, 12 Aug 2026 02:00:00 GMT',
            full_text: 'reply timeline version',
            quoted_status: [{ id_str: '1' }],
        };

        expect(mergeUserTimelines([detailedDuplicate], [mainOnly, mainDuplicate])).toEqual([mainOnly, detailedDuplicate]);
    });
});
