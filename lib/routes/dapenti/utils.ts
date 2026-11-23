import { type CheerioOptions, load } from 'cheerio';
import iconv from 'iconv-lite';

import cache from '@/utils/cache';
import got from '@/utils/got';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

const origin = 'https://www.dapenti.com';

type TuguaChannelResponse = {
    success: boolean;
    code?: string;
    hits: Array<{ id: number; topic: string; addtime: string; source_url: string }>;
};

async function parseTugua() {
    const link = `${origin}/blog/member-channel.asp?channel=tugua`;
    const channel = await ofetch<TuguaChannelResponse>(`${origin}/blog/member-search/api.asp`, {
        query: { channel: 'tugua', sort: 'newest', cursor: 0, limit: 30 },
    });
    if (!channel.success) {
        throw new Error(`Dapenti Tugua channel request failed: ${channel.code}`);
    }

    const items = await Promise.all(
        channel.hits.slice(0, 3).map((hit) => {
            const articleUrl = new URL(hit.source_url, origin).href;
            return cache.tryGet(articleUrl, async () => {
                const article = await ofetch(articleUrl, { responseType: 'arrayBuffer' });
                const $ = load(iconv.decode(Buffer.from(article), 'gbk'));
                const content = $('#article-content');
                if (!content.length) {
                    throw new Error(`Dapenti Tugua article content missing: ${articleUrl}`);
                }
                content.find('script, .adsbygoogle').remove();

                return {
                    title: hit.topic,
                    author: $('.article-meta').text().split('发布于', 1)[0].trim(),
                    description: content.html(),
                    pubDate: timezone(parseDate(hit.addtime, 'YYYY-MM-DD HH:mm:ss'), 8),
                    link: articleUrl,
                    // Keep the identifier readers received before the article URLs changed.
                    guid: `${origin}/blog/more.asp?name=xilei&id=${hit.id}`,
                };
            });
        })
    );

    return { title: '喷嚏-70', link, item: items };
}

export default {
    parseFeed: async ({ subjectid }) => {
        if (String(subjectid) === '70') {
            return parseTugua();
        }

        const url = `https://www.dapenti.com/blog/blog.asp?name=xilei&subjectid=${subjectid}`;
        const listRes = await got({
            method: 'get',
            url,
            headers: {
                Referer: url,
            },
            // 喷嚏网编码为GBK，需要转码
            // 转码需要设定返回数据的格式，其可选项是arraybuffer,blob,document,json,text,stream
            // 默认为json
            responseType: 'buffer',
        });
        // 转码
        const data = iconv.decode(listRes.data, 'gb2312');
        const $ = load(data);
        // 只取最近的三个，取全文rss
        const list = $('li', 'ul').slice(0, 3).toArray();

        const result_item = await Promise.all(
            list.map((item) =>
                cache.tryGet(`https://www.dapenti.com/blog/${$(item).find('a').attr('href')}`, async () => {
                    const el = $(item);
                    const url = `https://www.dapenti.com/blog/${el.find('a').attr('href')}`;
                    const original_data = await got({
                        method: 'get',
                        url,
                        headers: {
                            Referer: url,
                        },
                        responseType: 'buffer',
                    });
                    const convert_data = iconv.decode(original_data.data, 'gbk');
                    const description = load(convert_data, {
                        decodeEntities: false,
                    } as CheerioOptions)('body > table > tbody > tr > td.oblog_t_2 > div > table > tbody > tr:nth-child(2) > td');
                    const pubInfo = description.find('span span.oblog_text').text().split('发布于');
                    description.find('table, .adsbygoogle').remove();

                    // remove header
                    for (let index = 0; index < 3; index++) {
                        description.children().first().remove();
                    }

                    // remove footer
                    for (let index = 0; index < 8; index++) {
                        description.children().last().remove();
                    }
                    const single = {
                        title: el.text(),
                        author: pubInfo[0].trim(),
                        description: description.html(),
                        pubDate: timezone(parseDate(pubInfo[1]?.trim()), 8),
                        link: url,
                    };
                    return single;
                })
            )
        );

        return {
            title: `喷嚏-${subjectid}`,
            link: url,
            item: result_item,
        };
    },
};
