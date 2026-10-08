import pMap from 'p-map';

import type { ApiParams } from '../api/web-api/utils';
import { gatherLegacyFromData, paginationTweets } from '../api/web-api/utils';

type LegacyTweet = { id_str?: string; conversation_id_str?: string; in_reply_to_status_id_str?: string; retweeted_status?: LegacyTweet; conversation_context?: LegacyTweet[] };
type CacheTryGet = <T>(id: string, params: ApiParams | undefined, operationName: string, load: (userId: string, params: ApiParams) => Promise<T>) => Promise<T>;

export const getUserTweetsAndReplies = async (id: string, params: ApiParams | undefined, cacheTryGet: CacheTryGet, getUserTweet: (id: string, params?: ApiParams) => Promise<LegacyTweet[]>) => {
    const { detail, ...variables } = params ?? {};
    const replies = await cacheTryGet(id, variables, 'getUserTweetsAndReplies', async (userId, variables = {}) =>
        gatherLegacyFromData(
            await paginationTweets('UserRepliesTimeline', userId, {
                ...variables,
                count: variables.count ?? 20,
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

    return expandConversationContext(replies, id, getUserTweet);
};

export const expandConversationContext = (tweets: LegacyTweet[], id: string, getUserTweet: (id: string, params?: ApiParams) => Promise<LegacyTweet[]> | null) =>
    pMap(
        tweets,
        async (entry) => {
            const reply = entry.retweeted_status || entry;
            const replyId = reply.id_str || reply.conversation_id_str;
            if (!replyId || !reply.in_reply_to_status_id_str || reply.conversation_context?.length) {
                return entry;
            }
            try {
                const conversation = await getUserTweet(id, { focalTweetId: replyId });
                if (!conversation) {
                    return entry;
                }
                const byId = new Map(conversation.map((tweet) => [tweet.id_str || tweet.conversation_id_str, tweet]));
                const parents: LegacyTweet[] = [];
                const seen = new Set([replyId]);
                let parentId: string | undefined = reply.in_reply_to_status_id_str;
                while (parentId && !seen.has(parentId) && byId.has(parentId)) {
                    seen.add(parentId);
                    const parent = byId.get(parentId)!;
                    parents.unshift(parent);
                    parentId = parent.in_reply_to_status_id_str;
                }
                if (!parents.length) {
                    return entry;
                }
                const expanded = { ...reply, conversation_context: parents };
                return entry.retweeted_status ? { ...entry, retweeted_status: expanded } : expanded;
            } catch {
                // A failed detail request must not drop the reply itself or cache an incomplete expansion.
                return entry;
            }
        },
        { concurrency: 1 }
    );
