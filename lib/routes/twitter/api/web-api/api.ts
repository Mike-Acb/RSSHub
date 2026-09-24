import pMap from 'p-map';

import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';

import { getTwitterUserCacheKey } from '../../utils';
import { baseUrl, gqlFeatures, gqlMap, initGqlMap } from './constants';
import type { ApiParams } from './utils';
import { gatherLegacyFromData, paginationTweets, twitterGot } from './utils';

const getUserResult = (response: any) => {
    const errors = response?.errors;
    if (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0)) {
        const codes = Array.isArray(errors) ? [...new Set(errors.map((error) => error?.code).filter((code) => Number.isSafeInteger(code)))] : [];
        throw new Error(`Twitter API user lookup failed${codes.length ? ` (codes: ${codes.join(', ')})` : ''}`);
    }

    // Some third-party providers return errors with HTTP 200 outside GraphQL.
    const code = response?.code;
    if (Number.isSafeInteger(code) && code >= 400) {
        if (code === 404 && response.message === 'User not found') {
            throw new InvalidParameterError('Twitter API could not find this user');
        }
        throw new Error(`Twitter API user lookup failed (code: ${code})`);
    }

    const user = response?.data?.user === undefined ? response?.data?.user_result : response.data.user;
    if (user === null || user?.result === null) {
        throw new InvalidParameterError("This account doesn't exist");
    }
    const result = user?.result;
    if (result?.__typename === 'UserUnavailable') {
        throw new InvalidParameterError('Twitter user is unavailable');
    }
    if (!result || typeof result.rest_id !== 'string' || result.rest_id.length === 0) {
        throw new Error('Twitter API returned an incomplete user response');
    }
    return result;
};

const getUserData = async (id: string) => {
    // Other Twitter API adapters cache different schemas under the legacy key.
    const data = await cache.tryGet(`twitter:web:userdata:v2:${id}`, async () => {
        const params = {
            variables: id.startsWith('+')
                ? JSON.stringify({
                      userId: id.slice(1),
                      withSafetyModeUserFields: true,
                  })
                : JSON.stringify({
                      screen_name: id,
                      withSafetyModeUserFields: true,
                  }),
            features: JSON.stringify(id.startsWith('+') ? gqlFeatures.UserByRestId : gqlFeatures.UserByScreenName),
            fieldToggles: JSON.stringify({
                withAuxiliaryUserLabels: false,
            }),
        };

        const response = config.twitter.thirdPartyApi
            ? await ofetch(`${config.twitter.thirdPartyApi}${id.startsWith('+') ? gqlMap.UserByRestId : gqlMap.UserByScreenName}`, {
                  method: 'GET',
                  params,
                  headers: {
                      'accept-encoding': 'gzip',
                  },
              })
            : await twitterGot(`${baseUrl}${id.startsWith('+') ? gqlMap.UserByRestId : gqlMap.UserByScreenName}`, params, {
                  allowNoAuth: !id.startsWith('+'),
              });

        // HTTP 200 can still contain GraphQL errors; never cache those responses.
        getUserResult(response);
        return response;
    });
    return getUserResult(data);
};

const cacheTryGet = async <T>(_id: string, params: ApiParams | undefined, operationName: string, func: (id: string, params: ApiParams) => Promise<T>): Promise<T> => {
    const user = await getUserData(_id);
    return (await cache.tryGet(getTwitterUserCacheKey(user.rest_id, operationName, params), () => func(user.rest_id, params ?? {}), config.cache.routeExpire, false)) as T;
};

const getUserTweets = (id: string, params?: ApiParams) =>
    cacheTryGet(id, params, 'getUserTweets', async (id, params = {}) =>
        gatherLegacyFromData(
            await paginationTweets('UserTweets', id, {
                ...params,
                count: 20,
                includePromotedContent: true,
                withQuickPromoteEligibilityTweetFields: true,
                withVoice: true,
                withV2Timeline: true,
            })
        )
    );

const getUserTweetsAndReplies = async (id: string, params?: ApiParams) => {
    const { detail, ...variables } = params ?? {};
    const replies = await cacheTryGet(id, variables, 'getUserTweetsAndReplies', async (userId, variables = {}) =>
        gatherLegacyFromData(
            await paginationTweets('UserRepliesTimeline', userId, {
                ...variables,
                count: 20,
                includePromotedContent: true,
                withCommunity: true,
                withVoice: true,
                withV2Timeline: true,
            }),
            ['profile-conversation-'],
            userId
        )
    );
    if (!detail) {
        return replies;
    }

    return pMap(
        replies,
        async (reply) => {
            if (!reply.in_reply_to_status_id_str) {
                return reply;
            }
            try {
                const conversation = await getUserTweet(id, { focalTweetId: reply.id_str });
                const byId = new Map(conversation.map((tweet) => [tweet.id_str, tweet]));
                const parents: Array<(typeof conversation)[number]> = [];
                const seen = new Set([reply.id_str]);
                let parentId = reply.in_reply_to_status_id_str;
                while (parentId && !seen.has(parentId) && byId.has(parentId)) {
                    seen.add(parentId);
                    const parent = byId.get(parentId);
                    parents.unshift(parent);
                    parentId = parent.in_reply_to_status_id_str;
                }
                return parents.length ? { ...reply, conversation_context: parents } : reply;
            } catch {
                // A failed detail request must not drop the reply itself or cache an incomplete expansion.
                return reply;
            }
        },
        { concurrency: 1 }
    );
};

const getUserMedia = (id: string, params?: ApiParams) =>
    cacheTryGet(id, params, 'getUserMedia', async (id, params = {}) =>
        gatherLegacyFromData(
            await paginationTweets('UserMedia', id, {
                ...params,
                count: 20,
                includePromotedContent: false,
                withClientEventToken: false,
                withBirdwatchNotes: false,
                withVoice: true,
                withV2Timeline: true,
            })
        )
    );

const getUserLikes = (id: string, params?: ApiParams) =>
    cacheTryGet(id, params, 'getUserLikes', async (id, params = {}) =>
        gatherLegacyFromData(
            await paginationTweets('Likes', id, {
                ...params,
                includeHasBirdwatchNotes: false,
                includePromotedContent: false,
                withBirdwatchNotes: false,
                withVoice: false,
                withV2Timeline: true,
            })
        )
    );

const getUserTweet = (id: string, params?: ApiParams) =>
    cacheTryGet(id, params, 'getUserTweet', async (id, params = {}) =>
        gatherLegacyFromData(
            await paginationTweets(
                'TweetDetail',
                id,
                {
                    ...params,
                    includeHasBirdwatchNotes: false,
                    includePromotedContent: false,
                    withBirdwatchNotes: false,
                    withVoice: false,
                    withV2Timeline: true,
                },
                ['threaded_conversation_with_injections_v2']
            ),
            ['homeConversation-', 'conversationthread-']
        )
    );

const getSearch = async (keywords: string, params?: ApiParams) =>
    gatherLegacyFromData(
        await paginationTweets(
            'SearchTimeline',
            undefined,
            {
                ...params,
                rawQuery: keywords,
                count: 20,
                querySource: 'typed_query',
                product: 'Latest',
            },
            ['search_by_raw_query', 'search_timeline', 'timeline']
        )
    );

const getList = async (id: string, params?: ApiParams) =>
    gatherLegacyFromData(
        await paginationTweets(
            'ListLatestTweetsTimeline',
            undefined,
            {
                ...params,
                listId: id,
                count: 20,
            },
            ['list', 'tweets_timeline', 'timeline']
        ),
        ['listConversation-']
    );

const getUser = async (id: string) => {
    const user = await getUserData(id);
    return {
        ...user.legacy,
        ...user.core,
        profile_image_url: user.avatar?.image_url ?? user.legacy?.profile_image_url_https,
        description: user.profile_bio?.description ?? user.legacy?.description,
    };
};

const getHomeTimeline = async (id: string, params?: ApiParams) =>
    gatherLegacyFromData(
        await paginationTweets(
            'HomeTimeline',
            undefined,
            {
                ...params,
                count: 20,
                includePromotedContent: true,
                latestControlAvailable: true,
                requestContext: 'launch',
                withCommunity: true,
            },
            ['home', 'home_timeline_urt']
        )
    );

const getHomeLatestTimeline = async (id: string, params?: ApiParams) =>
    gatherLegacyFromData(
        await paginationTweets(
            'HomeLatestTimeline',
            undefined,
            {
                ...params,
                count: 20,
                includePromotedContent: true,
                latestControlAvailable: true,
                requestContext: 'launch',
                withCommunity: true,
            },
            ['home', 'home_timeline_urt']
        )
    );

export default {
    getUser,
    getUserTweets,
    getUserTweetsAndReplies,
    getUserMedia,
    getUserLikes,
    getUserTweet,
    getSearch,
    getList,
    getHomeTimeline,
    getHomeLatestTimeline,
    init: initGqlMap,
};
