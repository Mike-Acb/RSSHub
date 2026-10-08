import { beforeEach, expect, test, vi } from 'vitest';

import api from '../lib/routes/twitter/api/web-api/api';
import { buildGqlMap, fallbackIds } from '../lib/routes/twitter/api/web-api/gql-id-resolver';
import twitterUtils from '../lib/routes/twitter/utils';
import { getUserTimeline } from '../lib/routes/twitter/v2/user-feed';

const fixtures = vi.hoisted(() => ({
    calls: [] as string[],
    cache: new Map<string, unknown>(),
    failDetail: false,
    envelope: 'user' as 'user' | 'user_result',
    repost: false,
    mainOnly: false,
    user: { rest_id: '42', core: { name: 'Writer', screen_name: 'writer' }, avatar: { image_url: 'https://example.com/avatar.png' }, profile_bio: { description: 'New bio' } },
}));

vi.mock('../lib/utils/cache', () => ({
    default: {
        tryGet: async (key: string, fetcher: () => Promise<unknown>) => {
            if (!fixtures.cache.has(key)) {
                fixtures.cache.set(key, await fetcher());
            }
            return fixtures.cache.get(key);
        },
    },
}));
vi.mock('../lib/routes/twitter/api/web-api/utils', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    twitterGot: () => ({ data: { [fixtures.envelope]: { result: fixtures.user } } }),
    paginationTweets: (endpoint: string) => {
        fixtures.calls.push(endpoint);
        const tweet = (id: string, parent?: string, quote?: boolean) => ({
            entryId: `tweet-${id}`,
            content: {
                itemContent: {
                    tweet_results: {
                        result: {
                            rest_id: id,
                            core: { user_results: { result: fixtures.user } },
                            legacy: {
                                id_str: id,
                                user_id_str: '42',
                                created_at: new Date(Number(id) * 1000).toUTCString(),
                                full_text: `tweet ${id}`,
                                entities: { urls: [] },
                                ...(parent && { in_reply_to_status_id_str: parent }),
                                ...(quote && { is_quote_status: true }),
                            },
                        },
                    },
                },
            },
        });
        const repost = () => {
            const entry = tweet('301');
            Object.assign(entry.content.itemContent.tweet_results.result.legacy, {
                retweeted_status_result: { result: tweet('300', '200').content.itemContent.tweet_results.result },
            });
            return entry;
        };
        if (endpoint === 'UserTweets') {
            return fixtures.repost ? [repost()] : [];
        }
        if (endpoint === 'UserRepliesTimeline') {
            return fixtures.mainOnly ? [tweet('400', undefined, true)] : [tweet('300', '200'), tweet('400', undefined, true), ...(fixtures.repost ? [repost()] : [])];
        }
        if (endpoint === 'TweetDetail') {
            if (fixtures.failDetail) {
                fixtures.failDetail = false;
                throw new Error('Temporary detail failure');
            }
            return [tweet('300', '200'), tweet('200', '100'), tweet('100'), tweet('999')];
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    },
}));

beforeEach(() => {
    fixtures.envelope = 'user';
    fixtures.calls.length = 0;
    fixtures.cache.clear();
    fixtures.failDetail = false;
    fixtures.repost = false;
    fixtures.mainOnly = false;
});

test('detail expands a reply with its parents, not unrelated injected posts, and retains quoted replies', async () => {
    const replies = await api.getUserTweetsAndReplies('writer', { detail: true });
    expect(replies.map((reply) => reply.id_str)).toEqual(['300', '400']);
    expect(replies[0].conversation_context.map((post) => post.id_str)).toEqual(['100', '200']);
    expect(replies[1].is_quote_status).toBe(true);
    expect(fixtures.calls).toEqual(['UserRepliesTimeline', 'TweetDetail']);
});

test('retries a transiently failed detail lookup on the next feed request', async () => {
    fixtures.failDetail = true;
    const first = await api.getUserTweetsAndReplies('writer', { detail: true });
    expect(fixtures.calls).toEqual(['UserRepliesTimeline', 'TweetDetail']);
    expect(fixtures.failDetail).toBe(false);
    expect(first[0].conversation_context).toBeUndefined();
    const second = await api.getUserTweetsAndReplies('writer', { detail: true });
    expect(second[0].conversation_context.map((post) => post.id_str)).toEqual(['100', '200']);
    expect(fixtures.calls.filter((endpoint) => endpoint === 'TweetDetail')).toHaveLength(2);
});

test('shares the base replies cache without persisting detailed parents into it', async () => {
    const expanded = await api.getUserTweetsAndReplies('writer', { detail: true });
    const base = await api.getUserTweetsAndReplies('writer');
    expect(expanded[0].conversation_context.map((post) => post.id_str)).toEqual(['100', '200']);
    expect(base[0].conversation_context).toBeUndefined();
    expect(fixtures.calls).toEqual(['UserRepliesTimeline', 'TweetDetail']);
});

test('resolves the dedicated replies operation with its fallback ID', () => {
    expect(buildGqlMap(fallbackIds).UserRepliesTimeline).toMatch(/^\/graphql\/.+\/UserRepliesTimeline$/);
});

test('normalizes a newer user_result profile into author and description fields', async () => {
    fixtures.envelope = 'user_result';
    const profile = await api.getUser('writer');
    expect(profile).toMatchObject({ name: 'Writer', screen_name: 'writer', profile_image_url: 'https://example.com/avatar.png', description: 'New bio' });
});

test('keeps one fully expanded original when its self-repost also appears in the timeline', async () => {
    fixtures.repost = true;
    const timeline = await getUserTimeline(api, 'writer', {}, true, true);
    const feed = twitterUtils.ProcessFeed({ req: { param: () => 'readable=1' } }, { data: timeline });
    expect(feed.map((item) => item.link)).toEqual(['https://x.com/writer/status/400', 'https://x.com/writer/status/300']);
    expect(feed[1].description).toContain('tweet 200');
    expect(feed[1].description).toContain('tweet 100');
    expect(feed[1].description).not.toContain('tweet 999');
});

test('expands a reposted reply found only in the main timeline without mutating cached posts', async () => {
    fixtures.repost = true;
    fixtures.mainOnly = true;
    const timeline = await getUserTimeline(api, 'writer', {}, true, true);
    const feed = twitterUtils.ProcessFeed({ req: { param: () => 'readable=1' } }, { data: timeline });
    expect(feed.map((item) => item.link)).toEqual(['https://x.com/writer/status/400', 'https://x.com/writer/status/301']);
    expect(feed[1].description).toContain('tweet 200');
    expect(feed[1].description).toContain('tweet 100');
    expect(feed[1].description).not.toContain('tweet 999');
    const base = await api.getUserTweets('writer');
    expect(base[0].retweeted_status.conversation_context).toBeUndefined();
});
