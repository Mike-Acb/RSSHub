import { expect, test, vi } from 'vitest';

import { config } from '../lib/config';
import { route } from '../lib/routes/twitter/user';

const tweet = (id: string, text = id) => ({
    id_str: id,
    created_at: new Date(Number(id) * 1000).toUTCString(),
    full_text: text,
    entities: { urls: [] },
    user: { name: 'Writer', screen_name: 'writer', profile_image_url_https: 'https://example.com/writer.png' },
});
vi.mock('../lib/routes/twitter/api', () => ({
    default: {
        init: () => {},
        getUser: () => ({ name: 'Writer', screen_name: 'writer', profile_image_url: 'https://example.com/avatar_normal.jpg' }),
        getUserTweets: () => [tweet('300'), tweet('100')],
        getUserTweetsAndReplies: (_id: string, params: { detail?: boolean }) =>
            params.detail
                ? [{ ...tweet('200', 'reply'), in_reply_to_screen_name: 'friend', in_reply_to_status_id_str: '150', conversation_context: [tweet('50', 'thread root'), tweet('150', 'direct parent')] }]
                : [tweet('200'), tweet('100')],
    },
}));

const requestFeed = (routeParams: string) => route.handler({ req: { param: (key: string) => (key === 'id' ? 'writer' : routeParams) } } as unknown as Parameters<typeof route.handler>[0]);

const feedOptions =
    'includeReplies=1&detail=1&readable=1&authorNameBold=1&showAuthorInTitle=1&showAuthorInDesc=1&showQuotedAuthorAvatarInDesc=1&showAuthorAvatarInDesc=1&showEmojiForRetweetAndReply=1&showRetweetTextInTitle=0&addLinkForPics=1&showTimestampInDescription=1&showQuotedInTitle=1&heightOfPics=150';

const withWebApi = async (run: () => Promise<void>) => {
    const authToken = config.twitter.authToken;
    try {
        config.twitter.authToken = ['token'];
        await run();
    } finally {
        config.twitter.authToken = authToken;
    }
};

test('renders a feed URL copied with HTML-escaped separators exactly like the original URL', () =>
    withWebApi(async () => {
        const original = await requestFeed(feedOptions);
        const reply = original.item.find((item) => item.link.endsWith('/status/200'));
        expect(reply.description).toContain('<blockquote');
        expect(reply.description.indexOf('direct parent')).toBeLessThan(reply.description.indexOf('thread root'));
        expect(await requestFeed(feedOptions.replaceAll('&', '&amp;'))).toEqual(original);
    }));

test('ignores a line break copied into a feed option name', () =>
    withWebApi(async () => {
        const original = await requestFeed(feedOptions);
        expect(original.item[0].description).toContain("<img width='48' height='48' src='https://example.com/writer.png'");
        expect(await requestFeed(feedOptions.replace('showAuthorAvatarInDesc', 'showAuthor\nAvatarInDesc'))).toEqual(original);
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

test('ignores detail for a user timeline without replies or GraphQL authentication', async () => {
    const authToken = config.twitter.authToken;
    const thirdPartyApi = config.twitter.thirdPartyApi;
    try {
        config.twitter.authToken = undefined;
        config.twitter.thirdPartyApi = undefined;
        const ctx = { req: { param: (key: string) => (key === 'id' ? 'writer' : 'detail=1') } } as unknown as Parameters<typeof route.handler>[0];
        const feed = await route.handler(ctx);
        expect(feed).toMatchObject({ item: [{ title: '300' }, { title: '100' }] });
    } finally {
        config.twitter.authToken = authToken;
        config.twitter.thirdPartyApi = thirdPartyApi;
    }
});
