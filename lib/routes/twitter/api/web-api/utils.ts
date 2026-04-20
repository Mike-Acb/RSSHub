import { cookie as HttpCookieAgentCookie, CookieAgent } from 'http-cookie-agent/undici';
import queryString from 'query-string';
import { Cookie, CookieJar } from 'tough-cookie';
import undici, { Client, ProxyAgent } from 'undici';
import { generateHeaders, getOndemandFileUrl } from 'xclienttransaction';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import proxy from '@/utils/proxy';

import { baseUrl, bearerToken, gqlFeatures, gqlMap, thirdPartySupportedAPI } from './constants';
import login from './login';

let authTokenIndex = 0;

// Twitter Transaction 相关常量和功能
// 注意：原transaction-data.ts文件已合并到此文件中，以实现：
// 1. 减少文件数量，简化项目结构
// 2. 复用现有的网络请求基础设施（twitterGot, ofetch等）
// 3. 统一Twitter相关工具函数的管理
// 4. 更好地利用现有的Cookie和代理机制
const CACHE_KEY_TRANSACTION_DATA = 'twitter:transaction-data';
const CACHE_TTL_SUCCESS = 3600; // 1小时
const CACHE_TTL_ERROR = 300; // 5分钟

// 类型定义
interface TwitterTransactionData {
    homeHtml: string;
    ondemandJs: string;
}

/**
 * 获取Twitter主页HTML内容
 * 使用现有的twitterGot函数以复用认证和代理配置
 */
const fetchHomeHtml = async (): Promise<string> => {
    logger.debug('twitter-transaction: 开始获取Twitter主页HTML');

    try {
        // 使用标准请求头

        // 直接请求x.com主页，不使用twitterGot的API路径处理
        const response = await ofetch('https://x.com', {
            headers: generateHeaders(),
            timeout: 10000,
            retry: 3,
        });

        if (!response || typeof response !== 'string') {
            throw new Error('Invalid response format from x.com');
        }

        // 验证响应包含必要的SVG动画数据
        const hasAnimationData = /loading-x-anim-\d+/.test(response) && /<svg[^>]*>.*?<path[^>]*d="[^"]*"/.test(response);
        if (!hasAnimationData) {
            logger.warn('twitter-transaction: 主页HTML缺少预期的SVG动画数据，但继续处理');
        }

        logger.debug('twitter-transaction: 成功获取Twitter主页HTML');
        return response;
    } catch (error) {
        logger.error('twitter-transaction: 获取Twitter主页HTML失败:', error);
        throw new Error(`Failed to fetch home HTML: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
};

/**
 * 获取ondemand JavaScript文件内容
 * 使用ofetch直接请求JavaScript文件
 */
const fetchOndemandJs = async (ondemandUrl: string): Promise<string> => {
    logger.debug(`twitter-transaction: 开始获取ondemand JS文件: ${ondemandUrl}`);

    try {
        // 使用标准请求头
        const standardHeaders = generateHeaders();

        const response = await ofetch(ondemandUrl, {
            headers: {
                ...standardHeaders,
                Accept: '*/*',
                Referer: 'https://x.com/',
            },
            timeout: 10000,
            retry: 3,
        });

        let jsContent: string;

        // 记录响应类型用于调试
        const responseType = typeof response;
        const constructorName = response?.constructor?.name;
        logger.debug(`twitter-transaction: ondemand响应类型: ${responseType}, 构造函数: ${constructorName}`);

        // 处理不同类型的响应
        if (typeof response === 'string') {
            jsContent = response;
            logger.debug('twitter-transaction: 使用字符串响应');
        } else if (response && typeof response === 'object' && 'text' in response && typeof response.text === 'function') {
            // 处理Blob类型的响应
            logger.debug('twitter-transaction: 检测到Blob响应，转换为文本');
            jsContent = await response.text();
        } else if (response && typeof response === 'object' && response.constructor && response.constructor.name === 'Blob') {
            // 处理Blob对象
            logger.debug('twitter-transaction: 检测到Blob对象，转换为文本');
            jsContent = await (response as Blob).text();
        } else {
            throw new Error(`Unexpected response type from ondemand JS file: ${responseType}, constructor: ${constructorName}`);
        }

        // 验证JavaScript内容
        if (!jsContent) {
            throw new Error('Empty JavaScript content from ondemand file');
        }

        // 验证响应包含预期的JavaScript内容和关键字节索引模式
        if (!jsContent.includes('function') && !jsContent.includes('return')) {
            throw new Error('Response does not appear to be valid JavaScript');
        }

        logger.debug(`twitter-transaction: 成功获取ondemand JS文件，长度: ${jsContent.length}字符`);
        return jsContent;
    } catch (error) {
        logger.error('twitter-transaction: 获取ondemand JS文件失败:', error);
        throw new Error(`Failed to fetch ondemand JS: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
};

/**
 * 获取Twitter Transaction所需的数据（homeHtml和ondemandJs）
 * 包含智能缓存和错误处理，复用现有的网络基础设施
 */
const getTwitterTransactionData = async (): Promise<TwitterTransactionData> => {
    logger.debug('twitter-transaction: 开始获取Twitter transaction数据');

    try {
        // 尝试从缓存获取数据
        const cachedData = await cache.get(CACHE_KEY_TRANSACTION_DATA);
        if (cachedData) {
            logger.debug('twitter-transaction: 从缓存获取数据成功');
            return JSON.parse(cachedData);
        }

        // 缓存未命中，获取新数据
        logger.debug('twitter-transaction: 缓存未命中，获取新数据');

        // 获取homeHtml
        const homeHtml = await fetchHomeHtml();

        // 使用XClientTransactionJS提供的工具函数解析ondemand URL
        const ondemandUrl = getOndemandFileUrl(homeHtml);
        if (!ondemandUrl) {
            throw new Error('无法从HTML中提取ondemand URL');
        }

        // 获取ondemand JavaScript文件
        const ondemandJs = await fetchOndemandJs(ondemandUrl);

        // 最终验证数据质量

        const data: TwitterTransactionData = {
            homeHtml,
            ondemandJs,
        };

        // 缓存成功获取的数据
        await cache.set(CACHE_KEY_TRANSACTION_DATA, JSON.stringify(data), CACHE_TTL_SUCCESS);

        logger.debug('twitter-transaction: 成功获取并缓存Twitter transaction数据');
        return data;
    } catch (error) {
        logger.error('twitter-transaction: 获取Twitter transaction数据失败:', error);

        // 缓存错误状态（较短时间）以避免频繁重试
        await cache.set(CACHE_KEY_TRANSACTION_DATA, JSON.stringify({ homeHtml: '', ondemandJs: '' }), CACHE_TTL_ERROR);

        // 返回空数据而不是抛出错误，允许系统降级运行
        return {
            homeHtml: '',
            ondemandJs: '',
        };
    }
};

/**
 * 生成Twitter API请求所需的X-Client-Transaction-Id
 * @param method HTTP方法 (GET, POST, etc.)
 * @param path API路径
 * @returns Transaction ID字符串，失败时返回空字符串
 */
const token2Cookie = async (token) => {
    const c = await cache.get(`twitter:cookie:${token}`);
    if (c) {
        return c;
    }
    const jar = new CookieJar();
    await jar.setCookie(`auth_token=${token}`, 'https://x.com');
    try {
        const agent = proxy.proxyUri
            ? new ProxyAgent({
                  factory: (origin, opts) => new Client(origin as string, opts).compose(HttpCookieAgentCookie({ jar })),
                  uri: proxy.proxyUri,
              })
            : new CookieAgent({ cookies: { jar } });
        if (token) {
            await ofetch('https://x.com', {
                dispatcher: agent,
            });
        } else {
            const data = await ofetch('https://x.com/narendramodi?mx=2', {
                dispatcher: agent,
            });
            const gt = data.match(/document\.cookie="gt=(\d+)/)?.[1];
            if (gt) {
                jar.setCookieSync(`gt=${gt}`, 'https://x.com');
            }
        }
        const cookie = JSON.stringify(jar.serializeSync());
        cache.set(`twitter:cookie:${token}`, cookie);
        return cookie;
    } catch {
        // ignore
        return '';
    }
};

const lockPrefix = 'twitter:lock-token1:';

const getAuth = async (retry: number) => {
    if (config.twitter.authToken && retry > 0) {
        const index = authTokenIndex++ % config.twitter.authToken.length;
        const token = config.twitter.authToken[index];
        const lock = await cache.get(`${lockPrefix}${token}`, false);
        if (lock) {
            logger.debug(`twitter debug: twitter cookie for token ${token} is locked, retry: ${retry}`);
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 500 + 500));
            return await getAuth(retry - 1);
        } else {
            logger.debug(`twitter debug: lock twitter cookie for token ${token}`);
            await cache.set(`${lockPrefix}${token}`, '1', 20);
            return {
                token,
                username: config.twitter.username?.[index],
                password: config.twitter.password?.[index],
                authenticationSecret: config.twitter.authenticationSecret?.[index],
            };
        }
    }
};

export const twitterGot = async (
    url,
    params,
    options?: {
        allowNoAuth?: boolean;
    }
) => {
    const auth = await getAuth(30);

    if (!auth && !options?.allowNoAuth) {
        throw new ConfigNotFoundError('No valid Twitter token found');
    }

    const requestUrl = `${url}?${queryString.stringify(params)}`;

    let cookie: string | Record<string, any> | null | undefined = await token2Cookie(auth?.token);
    if (!cookie && auth) {
        cookie = await login({
            username: auth.username,
            password: auth.password,
            authenticationSecret: auth.authenticationSecret,
        });
    }
    let dispatchers:
        | {
              jar: CookieJar;
              agent: CookieAgent | ProxyAgent;
          }
        | undefined;
    if (cookie) {
        logger.debug(`twitter debug: got twitter cookie for token ${auth?.token}`);
        if (typeof cookie === 'string') {
            cookie = JSON.parse(cookie);
        }
        const jar = CookieJar.deserializeSync(cookie as any);
        const agent = proxy.proxyUri
            ? new ProxyAgent({
                  factory: (origin, opts) => new Client(origin as string, opts).compose(HttpCookieAgentCookie({ jar })),
                  uri: proxy.proxyUri,
              })
            : new CookieAgent({ cookies: { jar } });
        if (proxy.proxyUri) {
            logger.debug(`twitter debug: Proxying request: ${requestUrl}`);
        }
        dispatchers = {
            jar,
            agent,
        };
    } else if (auth) {
        throw new ConfigNotFoundError(`Twitter cookie for token ${auth?.token?.replace(/(\w{8})(\w+)/, (_, v1, v2) => v1 + '*'.repeat(v2.length))} is not valid`);
    }
    const jsonCookie = dispatchers
        ? Object.fromEntries(
              dispatchers.jar
                  .getCookieStringSync(url)
                  .split(';')
                  .map((c) => Cookie.parse(c)?.toJSON())
                  .map((c) => [c?.key, c?.value])
          )
        : {};

    // Use undici.fetch directly instead of ofetch.raw to preserve the CookieAgent
    // dispatcher. Two layers drop it in the normal path:
    //   1. ofetch does not forward `dispatcher` to its internal fetch() call
    //   2. wrappedFetch (request-rewriter) does `new Request(input, init)` which
    //      discards non-standard options like `dispatcher`
    // Additionally, setting `cookie` header manually doesn't work either because
    // the Fetch spec treats `cookie` as a forbidden header name, so
    // `new Request()` silently strips it.
    // The only way to send cookies via CookieAgent is to call undici.fetch with
    // the dispatcher option directly.
    //
    // Because undici.fetch is the standard Fetch API and does not support ofetch's
    // `onResponse` callback, the rate-limit and auth error handling that was
    // previously in `onResponse` is now inlined below.
    const response = await undici.fetch(requestUrl, {
        headers: {
            authority: 'x.com',
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            authorization: bearerToken,
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            dnt: '1',
            pragma: 'no-cache',
            referer: 'https://x.com/',
            'x-twitter-active-user': 'yes',
            'x-twitter-client-language': 'en',
            'x-csrf-token': jsonCookie.ct0,
            ...(auth?.token
                ? {
                      'x-twitter-auth-type': 'OAuth2Session',
                  }
                : {
                      'x-guest-token': jsonCookie.gt,
                  }),
        },
        dispatcher: dispatchers?.agent,
    });

    let responseData: any;
    try {
        responseData = await response.json();
    } catch {
        responseData = null;
    }

    // Handle rate limiting and auth errors
    const remaining = response.headers.get('x-rate-limit-remaining');
    const remainingInt = Number.parseInt(remaining || '0');
    const reset = response.headers.get('x-rate-limit-reset');
    logger.debug(
        `twitter debug: twitter rate limit remaining for token ${auth?.token} is ${remaining} and reset at ${reset}, auth: ${JSON.stringify(auth)}, status: ${response.status}, data: ${JSON.stringify(responseData?.data)}, cookie: ${JSON.stringify(dispatchers?.jar.serializeSync())}`
    );
    if (auth) {
        if (remaining && remainingInt < 2 && reset) {
            const resetTime = new Date(Number.parseInt(reset) * 1000);
            const delay = (resetTime.getTime() - Date.now()) / 1000;
            logger.debug(`twitter debug: twitter rate limit exceeded for token ${auth.token} with status ${response.status}, will unlock after ${delay}s`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', Math.ceil(delay) * 2);
        } else if (response.status === 429 || JSON.stringify(responseData?.data) === '{"user":{}}') {
            logger.debug(`twitter debug: twitter rate limit exceeded for token ${auth.token} with status ${response.status}`);
            await cache.set(`${lockPrefix}${auth.token}`, '1', 2000);
        } else if (response.status === 403 || response.status === 401) {
            const newCookie = await login({
                username: auth.username,
                password: auth.password,
                authenticationSecret: auth.authenticationSecret,
            });
            if (newCookie) {
                logger.debug(`twitter debug: reset twitter cookie for token ${auth.token}, ${newCookie}`);
                await cache.set(`twitter:cookie:${auth.token}`, newCookie, config.cache.contentExpire);
                await cache.set(`${lockPrefix}${auth.token}`, '', 1);
            } else {
                const tokenIndex = config.twitter.authToken?.indexOf(auth.token);
                if (tokenIndex !== undefined && tokenIndex !== -1) {
                    config.twitter.authToken?.splice(tokenIndex, 1);
                }
                if (auth.username) {
                    const usernameIndex = config.twitter.username?.indexOf(auth.username);
                    if (usernameIndex !== undefined && usernameIndex !== -1) {
                        config.twitter.username?.splice(usernameIndex, 1);
                    }
                }
                if (auth.password) {
                    const passwordIndex = config.twitter.password?.indexOf(auth.password);
                    if (passwordIndex !== undefined && passwordIndex !== -1) {
                        config.twitter.password?.splice(passwordIndex, 1);
                    }
                }
                logger.debug(`twitter debug: delete twitter cookie for token ${auth.token} with status ${response.status}, remaining tokens: ${config.twitter.authToken?.length}`);
                await cache.set(`${lockPrefix}${auth.token}`, '1', 3600);
            }
        } else {
            logger.debug(`twitter debug: unlock twitter cookie with success for token ${auth.token}`);
            await cache.set(`${lockPrefix}${auth.token}`, '', 1);
        }
    }

    if (response.status >= 400) {
        throw new Error(`Twitter API error: ${response.status}`);
    }

    if (auth?.token) {
        logger.debug(`twitter debug: update twitter cookie for token ${auth.token}`);
        await cache.set(`twitter:cookie:${auth.token}`, JSON.stringify(dispatchers?.jar.serializeSync()), config.cache.contentExpire);
    }

    return responseData;
};

export const paginationTweets = async (endpoint: string, userId: number | undefined, variables: Record<string, any>, path?: string[]) => {
    const params = {
        variables: JSON.stringify({ ...variables, userId }),
        features: JSON.stringify(gqlFeatures[endpoint]),
    };

    const fetchData = async () => {
        if (config.twitter.thirdPartyApi && thirdPartySupportedAPI.includes(endpoint)) {
            const { data } = await ofetch(`${config.twitter.thirdPartyApi}${gqlMap[endpoint]}`, {
                method: 'GET',
                params,
                headers: {
                    'accept-encoding': 'gzip',
                },
            });
            return data;
        }
        const { data } = await twitterGot(baseUrl + gqlMap[endpoint], params);
        return data;
    };

    const getInstructions = (data: any) => {
        if (path) {
            let instructions = data;
            for (const p of path) {
                instructions = instructions[p];
            }
            return instructions.instructions;
        }

        const userResult = data?.user?.result;
        const timeline = userResult?.timeline?.timeline || userResult?.timeline?.timeline_v2 || userResult?.timeline_v2?.timeline;
        const instructions = timeline?.instructions;
        if (!instructions) {
            logger.debug(`twitter debug: instructions not found in data: ${JSON.stringify(data)}`);
        }
        return instructions;
    };

    const data = await fetchData();
    const instructions = getInstructions(data);
    if (!instructions) {
        return [];
    }

    const moduleItems = instructions.find((i) => i.type === 'TimelineAddToModule')?.moduleItems;
    const entries = instructions.find((i) => i.type === 'TimelineAddEntries')?.entries;
    const gridEntries = entries?.find((i) => i.entryId === 'profile-grid-0')?.content?.items;

    return gridEntries || moduleItems || entries || [];
};

/**
 * 清除缓存的transaction数据（用于调试或强制刷新）
 */
export const clearTwitterTransactionDataCache = async (): Promise<void> => {
    await cache.set(CACHE_KEY_TRANSACTION_DATA, '', 1);
    logger.debug('twitter-transaction: 已清除transaction数据缓存');
};

/**
 * 调试函数：验证并打印获取到的数据格式（仅用于开发调试）
 */
export const debugTwitterTransactionData = async (): Promise<void> => {
    try {
        const { homeHtml, ondemandJs } = await getTwitterTransactionData();

        logger.info('=== Twitter Transaction Data Debug ===');

        // 测试XClientTransactionJS工具函数
        try {
            const ondemandUrl = getOndemandFileUrl(homeHtml);
            logger.info(`使用XClientTransactionJS解析的ondemand URL: ${ondemandUrl}`);
        } catch (error) {
            logger.warn('XClientTransactionJS getOndemandFileUrl解析失败:', error);
        }

        // 检查homeHtml中的SVG动画数据
        const animDivs = homeHtml.match(/loading-x-anim-\d+/g) || [];
        const svgPaths = homeHtml.match(/<svg[^>]*>.*?<path[^>]*d="[^"]*"/g) || [];

        logger.info(`Home HTML - 动画div数量: ${animDivs.length}, SVG路径数量: ${svgPaths.length}`);
        if (animDivs.length > 0) {
            logger.info(`找到的动画div: ${animDivs.slice(0, 4).join(', ')}`);
        }

        // 检查ondemandJs中的关键字节索引
        const keyByteMatches = ondemandJs.match(/\(a\[\d+\],\s*\d+\)/g) || [];
        const arrayAccessMatches = ondemandJs.match(/a\[\d+\]/g) || [];

        logger.info(`Ondemand JS - 文件大小: ${ondemandJs.length}字符, 关键字节模式: ${keyByteMatches.length}, 数组访问: ${arrayAccessMatches.length}`);
        if (keyByteMatches.length > 0) {
            logger.info(`找到的关键字节模式: ${keyByteMatches.slice(0, 5).join(', ')}`);
        }

        // 显示JavaScript文件的开头部分用于验证
        const preview = ondemandJs.slice(0, 200) + (ondemandJs.length > 200 ? '...' : '');
        logger.info(`Ondemand JS预览: ${preview}`);

        // 测试标准请求头生成
        try {
            const headers = generateHeaders();
            logger.info(`XClientTransactionJS生成的标准请求头数量: ${Object.keys(headers).length}`);
        } catch (error) {
            logger.warn('XClientTransactionJS generateHeaders失败:', error);
        }

        logger.info('=== Debug Complete ===');
    } catch (error) {
        logger.error('twitter-transaction: 调试数据获取失败:', error);
    }
};

export function gatherLegacyFromData(entries: any[], filterNested?: string[], userId?: number | string) {
    const tweets: any[] = [];
    const filteredEntries: any[] = [];
    for (const entry of entries) {
        const entryId = entry.entryId;
        if (entryId) {
            if (entryId.startsWith('tweet-')) {
                filteredEntries.push(entry);
            } else if (entryId.startsWith('profile-grid-0-tweet-')) {
                filteredEntries.push(entry);
            }
            if (filterNested && filterNested.some((f) => entryId.startsWith(f))) {
                filteredEntries.push(...entry.content.items);
            }
        }
    }
    for (const entry of filteredEntries) {
        if (entry.entryId) {
            const content = entry.content || entry.item;
            let tweet = content?.content?.tweetResult?.result || content?.itemContent?.tweet_results?.result;
            if (tweet && tweet.tweet) {
                tweet = tweet.tweet;
            }
            if (tweet) {
                const retweet = tweet.legacy?.retweeted_status_result?.result;
                for (const t of [tweet, retweet]) {
                    if (!t?.legacy) {
                        continue;
                    }
                    t.legacy.user = t.core?.user_result?.result?.legacy || t.core?.user_results?.result?.legacy;
                    // Add name and screen_name from core to maintain compatibility
                    if (t.legacy.user && t.core?.user_results?.result?.core) {
                        const coreUser = t.core.user_results.result.core;
                        if (coreUser.name) {
                            t.legacy.user.name = coreUser.name;
                        }
                        if (coreUser.screen_name) {
                            t.legacy.user.screen_name = coreUser.screen_name;
                        }
                    }
                    t.legacy.id_str = t.rest_id; // avoid falling back to conversation_id_str elsewhere
                    const quote = t.quoted_status_result?.result?.tweet || t.quoted_status_result?.result;
                    if (quote) {
                        t.legacy.quoted_status = quote.legacy;
                        t.legacy.quoted_status.user = quote.core.user_result?.result?.legacy || quote.core.user_results?.result?.legacy;
                        // Add name and screen_name from core for quoted status user
                        if (t.legacy.quoted_status.user && quote.core?.user_results?.result?.core) {
                            const quoteCoreUser = quote.core.user_results.result.core;
                            if (quoteCoreUser.name) {
                                t.legacy.quoted_status.user.name = quoteCoreUser.name;
                            }
                            if (quoteCoreUser.screen_name) {
                                t.legacy.quoted_status.user.screen_name = quoteCoreUser.screen_name;
                            }
                        }
                    }
                    if (t.note_tweet) {
                        const tmp = t.note_tweet.note_tweet_results.result;
                        t.legacy.entities.hashtags = tmp.entity_set.hashtags;
                        t.legacy.entities.symbols = tmp.entity_set.symbols;
                        t.legacy.entities.urls = tmp.entity_set.urls;
                        t.legacy.entities.user_mentions = tmp.entity_set.user_mentions;
                        t.legacy.full_text = tmp.text;
                    }
                }
                const legacy = tweet.legacy;
                if (legacy) {
                    if (retweet) {
                        legacy.retweeted_status = retweet.legacy;
                    }
                    if (userId === undefined || legacy.user_id_str === userId + '') {
                        tweets.push(legacy);
                    }
                }
            }
        }
    }

    return tweets;
}
