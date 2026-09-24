import { expect, test, vi } from 'vitest';

import { config } from '../lib/config';
import { route } from '../lib/routes/twitter/user';

const tweet = (id: string) => ({ id_str: id, created_at: new Date(Number(id) * 1000).toUTCString(), full_text: id, entities: { urls: [] }, user: { name: 'Writer', screen_name: 'writer' } });
vi.mock('../lib/routes/twitter/api', () => ({
    default: {
        init: () => {},
        getUser: () => ({ name: 'Writer', screen_name: 'writer', profile_image_url: 'https://example.com/avatar_normal.jpg' }),
        getUserTweets: () => [tweet('300'), tweet('100')],
        getUserTweetsAndReplies: () => [tweet('200'), tweet('100')],
    },
}));

test('includeReplies merges main posts and replies without duplicate entries', async () => {
    const ctx = { req: { param: (key: string) => (key === 'id' ? 'writer' : 'includeReplies=1') } } as unknown as Parameters<typeof route.handler>[0];
    const feed = await route.handler(ctx);
    expect(feed).toMatchObject({ item: [{ title: '300' }, { title: '200' }, { title: '100' }] });
});

test('rejects conversation detail without a GraphQL-capable API', async () => {
    const authToken = config.twitter.authToken;
    const thirdPartyApi = config.twitter.thirdPartyApi;
    try {
        config.twitter.authToken = undefined;
        config.twitter.thirdPartyApi = undefined;
        const ctx = { req: { param: (key: string) => (key === 'id' ? 'writer' : 'includeReplies=1&detail=1') } } as unknown as Parameters<typeof route.handler>[0];
        await expect(route.handler(ctx)).rejects.toThrow('detail requires Twitter Web API or a third-party GraphQL API');
    } finally {
        config.twitter.authToken = authToken;
        config.twitter.thirdPartyApi = thirdPartyApi;
    }
});
