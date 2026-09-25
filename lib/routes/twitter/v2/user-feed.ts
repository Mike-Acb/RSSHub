import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import type api from '../api';

// Feed URLs copied from rendered XML keep `&amp;` separators, and copies of a wrapped terminal line gain line breaks.
export const parseRouteQuery = (routeParams: string | undefined) => new URLSearchParams(routeParams?.replaceAll(/&(?:amp;)+/g, '&').replaceAll(/\s/g, ''));

export const parseUserFeedDetail = (routeParams: string | undefined, includeReplies: boolean) => {
    const detail = fallback(undefined, queryToBoolean(parseRouteQuery(routeParams).get('detail')), false);
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

interface AuthoredStatus extends QuotedStatus {
    user: NonNullable<QuotedStatus['user']>;
}

interface QuotedSelection {
    statuses: AuthoredStatus[];
    context: AuthoredStatus[];
    linkedQuote?: AuthoredStatus;
}

const noQuotes: QuotedSelection = { statuses: [], context: [] };

const isAuthored = (status?: QuotedStatus): status is AuthoredStatus => Boolean(status?.user?.name && status.user.screen_name);

// Quoted posts keep the upstream quote layout; reply parents are returned separately, nearest parent first.
export const selectQuotedStatuses = (item: { is_quote_status?: boolean; quoted_status?: QuotedStatus | QuotedStatus[]; conversation_context?: QuotedStatus[] }): QuotedSelection => {
    if (!item.is_quote_status && !item.conversation_context?.length) {
        return noQuotes;
    }
    const quoted: Array<QuotedStatus | undefined> = !item.is_quote_status || !item.quoted_status ? [] : Array.isArray(item.quoted_status) ? item.quoted_status : [item.quoted_status];
    const statuses = quoted.filter((status): status is AuthoredStatus => isAuthored(status));
    return { statuses, context: item.conversation_context?.toReversed().filter((status): status is AuthoredStatus => isAuthored(status)) ?? [], linkedQuote: statuses[0] };
};
