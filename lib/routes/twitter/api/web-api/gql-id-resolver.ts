import { cookie as HttpCookieAgentCookie, CookieAgent } from 'http-cookie-agent/undici';
import { CookieJar } from 'tough-cookie';
import undici, { Client, ProxyAgent } from 'undici';

import { config } from '@/config';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import proxy from '@/utils/proxy';

const CACHE_KEY = 'twitter:gql-query-ids';

// Hardcoded fallback IDs (last known working values)
export const fallbackIds: Record<string, string> = {
    UserTweets: 'T1x2zehUOKCWNpKwZCpnbg',
    UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
    HomeTimeline: 'xhYBF94fPSp8ey64FfYXiA',
    HomeLatestTimeline: '0vp2Au9doTKsbn2vIk48Dg',
    // X retired UserTweetsAndReplies (its bundle entry is dead code — the gateway 404s it)
    // and split the profile tabs into UserRepliesTimeline / UserRepostsTimeline / UserPhotoTimeline / ...
    UserRepliesTimeline: '2anL22XLKS0gNMtm1tSAcQ',
    UserMedia: 'e2LuQ6Xj-VZ4Nvtfig5eFw',
    UserByRestId: 'xvmVfRLmnr1alc5f2dib0Q',
    SearchTimeline: 'PusO6nN_nUSAsfJktZJd9w',
    ListLatestTweetsTimeline: 'Pa45JvqZuKcW1plybfgBlQ',
    TweetDetail: 'VmqMAqtSRNBt_8fGV3n5Cg',
    Likes: 'FRoquLK03At_BEbqVw3OHg',
};

const operationNames = Object.keys(fallbackIds);

// The logged-out x.com shell is a separate lightweight app (x-web/entry-client-logged-out-*.js)
// that does not reference the client-web bundle carrying the GraphQL query IDs. Only an
// authenticated request to /home returns the real app shell, so send the auth cookie here.
async function fetchTwitterPage(): Promise<string> {
    const token = config.twitter.authToken?.[0];
    if (!token) {
        logger.warn('twitter gql-id-resolver: no auth token available, cannot reach the logged-in shell');
        return '';
    }

    const jar = new CookieJar();
    await jar.setCookie(`auth_token=${token}`, 'https://x.com');
    const agent = proxy.proxyUri
        ? new ProxyAgent({
              factory: (origin, opts) => new Client(origin as string, opts).compose(HttpCookieAgentCookie({ jar })),
              uri: proxy.proxyUri,
          })
        : new CookieAgent({ cookies: { jar } });

    const response = await undici.fetch('https://x.com/home', {
        headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
        },
        dispatcher: agent,
    });
    return await response.text();
}

function extractQueryIds(scriptContent: string): Record<string, string> {
    const ids: Record<string, string> = {};
    const matches = scriptContent.matchAll(/queryId:"([^"]+?)".+?operationName:"([^"]+?)"/g);
    for (const match of matches) {
        const [, queryId, operationName] = match;
        if (operationNames.includes(operationName)) {
            ids[operationName] = queryId;
        }
    }
    return ids;
}

async function fetchAndExtractIds(): Promise<Record<string, string>> {
    const html = await fetchTwitterPage();

    // Extract main.hash.js URL — it contains all the GraphQL query IDs we need
    const mainMatch = html.match(/\/client-web\/main\.([a-z0-9]+)\./);
    if (!mainMatch) {
        logger.warn('twitter gql-id-resolver: main.js URL not found in Twitter page');
        return {};
    }

    const mainUrl = `https://abs.twimg.com/responsive-web/client-web/main.${mainMatch[1]}.js`;
    logger.debug(`twitter gql-id-resolver: fetching ${mainUrl}`);

    const content = await ofetch(mainUrl, {
        parseResponse: (txt) => txt,
    });
    return extractQueryIds(content as unknown as string);
}

let resolvePromise: Promise<Record<string, string>> | null = null;

export async function resolveQueryIds(): Promise<Record<string, string>> {
    // Check cache first
    const cached = await cache.get(CACHE_KEY);
    if (cached) {
        try {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                logger.debug('twitter gql-id-resolver: using cached query IDs');
                return { ...fallbackIds, ...parsed };
            }
        } catch {
            // ignore parse error
        }
    }

    // Deduplicate concurrent requests
    if (!resolvePromise) {
        resolvePromise = (async () => {
            try {
                logger.info('twitter gql-id-resolver: fetching fresh query IDs from Twitter JS bundles');
                const ids = await fetchAndExtractIds();

                if (Object.keys(ids).length > 0) {
                    await cache.set(CACHE_KEY, JSON.stringify(ids), config.cache.contentExpire);
                    const found = operationNames.filter((name) => ids[name]);
                    const missing = operationNames.filter((name) => !ids[name]);
                    logger.debug(`twitter gql-id-resolver: resolved ${found.length}/${operationNames.length} query IDs. Missing: ${missing.join(', ') || 'none'}`);
                } else {
                    logger.warn('twitter gql-id-resolver: failed to extract any query IDs, using fallback');
                }

                return ids;
            } catch (error) {
                logger.warn(`twitter gql-id-resolver: error fetching query IDs: ${error}. Using fallback.`);
                return {};
            } finally {
                resolvePromise = null;
            }
        })();
    }

    const ids = await resolvePromise;
    return { ...fallbackIds, ...ids };
}

export function buildGqlMap(queryIds: Record<string, string>): Record<string, string> {
    const map: Record<string, string> = {};
    for (const name of operationNames) {
        const id = queryIds[name] || fallbackIds[name];
        map[name] = `/graphql/${id}/${name}`;
    }
    return map;
}
