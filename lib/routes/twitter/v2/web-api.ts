import pMap from 'p-map';

import type { ApiParams } from '../api/web-api/utils';
import { gatherLegacyFromData, paginationTweets } from '../api/web-api/utils';

type LegacyTweet = { id_str: string; in_reply_to_status_id_str?: string };
type CacheTryGet = <T>(id: string, params: ApiParams | undefined, operationName: string, load: (userId: string, params: ApiParams) => Promise<T>) => Promise<T>;

export const getUserTweetsAndReplies = async (id: string, params: ApiParams | undefined, cacheTryGet: CacheTryGet, getUserTweet: (id: string, params?: ApiParams) => Promise<LegacyTweet[]>) => {
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
                    const parent = byId.get(parentId)!;
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
