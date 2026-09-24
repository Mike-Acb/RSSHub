import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import type api from '../api';

export const parseUserFeedDetail = (routeParams: string | undefined, includeReplies: boolean) => {
    const detail = fallback(undefined, queryToBoolean(new URLSearchParams(routeParams).get('detail')), false);
    if (includeReplies && detail && !config.twitter.authToken && !config.twitter.thirdPartyApi) {
        throw new InvalidParameterError('detail requires Twitter Web API or a third-party GraphQL API');
    }
    return detail;
};

export const mergeUserTimelines = <T extends { id_str?: string; conversation_id_str?: string; created_at: string }>(replies: T[], tweets: T[]): T[] => {
    const merged = new Map<string, T>();
    for (const tweet of tweets) {
        const id = tweet.id_str || tweet.conversation_id_str;
        if (id) {
            merged.set(id, tweet);
        }
    }
    for (const reply of replies) {
        const id = reply.id_str || reply.conversation_id_str;
        if (id) {
            merged.set(id, reply);
        }
    }
    return merged
        .values()
        .toArray()
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
};

export const getUserTimeline = async (client: Pick<typeof api, 'getUserTweets' | 'getUserTweetsAndReplies'>, id: string, params: { count?: number }, includeReplies: boolean, detail: boolean) => {
    if (!includeReplies) {
        return await client.getUserTweets(id, params);
    }
    const replies = await client.getUserTweetsAndReplies(id, { ...params, detail });
    const tweets = await client.getUserTweets(id, params);
    return mergeUserTimelines(replies, tweets);
};

interface QuotedStatus {
    user?: { name: string; screen_name: string; profile_image_url_https?: string };
    full_text?: string;
    text?: string;
    id_str?: string;
    conversation_id_str?: string;
    created_at: string;
}

interface QuotedSelection {
    statuses: QuotedStatus[];
    linkedQuote?: QuotedStatus;
}

const noQuotes: QuotedSelection = { statuses: [] };

export const selectQuotedStatuses = (item: { is_quote_status?: boolean; quoted_status?: QuotedStatus | QuotedStatus[]; conversation_context?: QuotedStatus[] }): QuotedSelection => {
    if (!item.is_quote_status && !item.conversation_context?.length) {
        return noQuotes;
    }
    const quoted: QuotedStatus[] = !item.is_quote_status || !item.quoted_status ? [] : Array.isArray(item.quoted_status) ? item.quoted_status : [item.quoted_status];
    const linkedQuote = quoted.find((status) => status?.user?.name && status.user.screen_name);
    const statuses = [...(item.conversation_context?.toReversed() ?? []), ...quoted].filter((status) => status?.user?.name && status.user.screen_name);
    return { statuses, linkedQuote };
};
