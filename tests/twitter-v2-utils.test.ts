import { describe, expect, test } from 'vitest';

import { gatherLegacyFromData } from '../lib/routes/twitter/api/web-api/utils';
import twitterUtils from '../lib/routes/twitter/utils';
import { mergeUserTimelines } from '../lib/routes/twitter/v2/user-feed';

const makeTweet = (id: string, text = id) => ({
    id_str: id,
    created_at: new Date(Number(id) * 1000).toUTCString(),
    full_text: text,
    entities: { urls: [] },
    user: { name: 'Writer', screen_name: 'writer', profile_image_url_https: 'https://example.com/avatar' },
});

const context = { req: { param: () => '' } };

const timelineEntry = (
    id: string,
    user: { rest_id: string; core?: { name: string; screen_name: string }; legacy?: { name: string; screen_name: string; profile_image_url_https: string }; avatar?: { image_url: string } },
    quoted?: object
) => ({
    entryId: `tweet-${id}`,
    content: {
        itemContent: {
            tweet_results: {
                result: {
                    rest_id: id,
                    core: { user_results: { result: user } },
                    legacy: { id_str: id, user_id_str: user.rest_id, full_text: id, entities: { urls: [] } },
                    ...(quoted && { quoted_status_result: { result: quoted } }),
                },
            },
        },
    },
});

describe('Twitter user feed', () => {
    test('merges replies with main tweets without dropping originals, preferring detailed duplicates in descending order', () => {
        const main = [makeTweet('300', 'main original'), makeTweet('100', 'main copy')];
        const replies = [
            { ...makeTweet('200'), quoted_status: [makeTweet('50')] },
            { ...makeTweet('100', 'detailed reply'), quoted_status: [makeTweet('20')] },
        ];
        const result = mergeUserTimelines(replies, main);
        expect(result.map((tweet) => tweet.id_str)).toEqual(['300', '200', '100']);
        expect(result[2]).toMatchObject({ quoted_status: [makeTweet('20')] });
    });

    test('renders an expanded reply conversation with several parent posts as quoted entries', () => {
        const reply = { ...makeTweet('300', 'reply'), is_quote_status: true, in_reply_to_screen_name: 'parent', quoted_status: [makeTweet('100', 'parent one'), makeTweet('200', 'parent two')] };
        const [item] = twitterUtils.ProcessFeed(context, { data: [reply] });
        expect(item.description).toContain('parent one');
        expect(item.description).toContain('parent two');
        expect(item.description).not.toContain('undefined');
    });
    test('keeps reply metadata when parent posts are rendered as conversation context', () => {
        const reply = { ...makeTweet('300', 'reply'), in_reply_to_screen_name: 'parent', in_reply_to_status_id_str: '200', conversation_context: [makeTweet('200', 'parent')] };
        const [item] = twitterUtils.ProcessFeed(context, { data: [reply] });
        expect(item.description).toContain('parent');
        expect(item._extra).toEqual({ links: [{ type: 'reply', url: 'https://x.com/parent/status/200' }] });
    });
    test('preserves a singular quote link and ignores unavailable entries before a valid quoted post', () => {
        const quote = makeTweet('200', 'quoted text');
        const singular = twitterUtils.ProcessFeed(context, { data: [{ ...makeTweet('300', 'original'), is_quote_status: true, quoted_status: quote }] })[0];
        expect(singular.description).toContain('quoted text');
        expect(singular._extra).toEqual({ links: [{ type: 'quote', url: 'https://x.com/writer/status/200' }] });

        const multiple = twitterUtils.ProcessFeed(context, { data: [{ ...makeTweet('301', 'reply'), is_quote_status: true, quoted_status: [{ id_str: 'missing' }, quote] }] })[0];
        expect(multiple.description).toContain('quoted text');
        expect(multiple.description).not.toContain('undefined');
        expect(multiple._extra).toEqual({ links: [{ type: 'quote', url: 'https://x.com/writer/status/200' }] });
    });

    test('hydrates new-style authors and ignores unavailable quoted tweet tombstones', () => {
        const user = { rest_id: '42', core: { name: 'New User', screen_name: 'newuser' }, avatar: { image_url: 'https://example.com/new.png' } };
        const entries = [timelineEntry('300', user, { __typename: 'TweetTombstone' })];
        const [tweet] = gatherLegacyFromData(entries, undefined, '42');
        expect(tweet.user).toEqual({ name: 'New User', screen_name: 'newuser', profile_image_url_https: 'https://example.com/new.png' });
        const [item] = twitterUtils.ProcessFeed(context, { data: [tweet] }, { showAuthorInDesc: true });
        expect(item.author[0].name).toBe('New User');
        expect(item.description).not.toContain('undefined');
    });
    test('hydrates an author from the singular user_result shape', () => {
        const user = { rest_id: '42', core: { name: 'Single User', screen_name: 'single' } };
        const entry = timelineEntry('304', user);
        Object.assign(entry.content.itemContent.tweet_results.result, { core: { user_result: { result: user } } });
        const [tweet] = gatherLegacyFromData([entry], undefined, '42');
        expect(tweet.user.name).toBe('Single User');
    });
    test('retains author fields when a GraphQL user has only legacy fields', () => {
        const user = { rest_id: '42', legacy: { name: 'Legacy User', screen_name: 'legacy', profile_image_url_https: 'https://example.com/legacy.png' } };
        const [tweet] = gatherLegacyFromData([timelineEntry('301', user)], undefined, '42');
        const [item] = twitterUtils.ProcessFeed(context, { data: [tweet] }, { showAuthorInDesc: true });
        expect(item.author[0].name).toBe('Legacy User');
        expect(item.description).not.toContain('undefined');
    });
    test('does not expose feed entries without an author', () => {
        const user = { rest_id: '42', core: { name: 'New User', screen_name: 'newuser' } };
        const missingAuthor = timelineEntry('302', user);
        Object.assign(missingAuthor.content.itemContent.tweet_results.result.core.user_results, { result: null });
        const tweets = gatherLegacyFromData([missingAuthor, timelineEntry('303', user)], undefined, '42');
        const rendered = twitterUtils.ProcessFeed(context, { data: tweets }, { showAuthorInDesc: true });
        expect(rendered.map((item) => item.author[0].name)).toEqual(['New User']);
        expect(rendered[0].description).not.toContain('undefined');
    });
});
