import { http, HttpResponse } from 'msw';
import Parser from 'rss-parser';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.GEMINI_API_KEY = 'gemini-test-key';
process.env.GEMINI_API_ENDPOINT = 'http://gemini.mock/v1beta';

vi.mock('../lib/utils/request-rewriter', () => ({ default: null }));
const { default: server } = await import('../lib/setup.test');
const { default: app } = await import('../lib/app');
const { default: cache } = await import('../lib/utils/cache');
const { config } = await import('../lib/config');
const { default: logger } = await import('../lib/utils/logger');
const { insertTranslation, needsTranslation, splitSegments } = await import('../lib/v2/translate/bilingual');
const { translateFeed } = await import('../lib/v2/translate');

const parser = new Parser();
const translation = (text: string) => `<br><span class="rsshub-translation" style="opacity: 0.7; font-style: normal;">${text}</span>`;
const textsOf = (html: string) => splitSegments(html).segments.map((segment) => segment.text);
interface GeminiCall {
    path: string;
    apiKey: string | null;
    thinking?: unknown;
    texts: string[];
}
const geminiCalls: GeminiCall[] = [];

interface GeminiMock {
    status?: number | ((call: GeminiCall) => number);
    message?: string;
    translate?: (text: string) => string;
    // Turns the translations into the reply text, which a test can cut short or leave an item out of.
    answer?: (translations: string[], call: GeminiCall) => string;
}
const mockGemini = ({ status = 200, message = 'Internal error', translate = (text: string) => `译:${text}`, answer = (translations: string[]) => JSON.stringify(translations) }: GeminiMock = {}) =>
    server.use(
        http.post('http://gemini.mock/v1beta/models/*', async ({ request }) => {
            const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: { thinkingConfig?: unknown } };
            const texts: string[] = JSON.parse(body.contents[0].parts[0].text);
            const call = { path: new URL(request.url).pathname, apiKey: request.headers.get('x-goog-api-key'), thinking: body.generationConfig.thinkingConfig, texts };
            geminiCalls.push(call);
            const code = typeof status === 'number' ? status : status(call);
            if (code !== 200) {
                return HttpResponse.json({ error: { code, message } }, { status: code });
            }
            const translations = texts.map((text) => translate(text));
            return HttpResponse.json({ candidates: [{ content: { parts: [{ text: answer(translations, call) }] }, finishReason: 'STOP' }] });
        })
    );

const requestFeed = async (path: string) => parser.parseString(await (await app.request(path)).text());

beforeEach(() => {
    geminiCalls.length = 0;
    cache.clients.memoryCache?.clear();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('bilingual segments', () => {
    test('splits paragraphs and lines but skips code, media and fine print', () => {
        expect(textsOf('<p>First paragraph.</p><p>Second <a href="#">linked</a> sentence.<br>Next line</p><pre>const code = 1;</pre><img src="a.jpg"><small>Link: https://x.com</small>')).toEqual([
            'First paragraph.',
            'Second linked sentence.',
            'Next line',
        ]);
    });

    test('puts each escaped translation under the line it translates', () => {
        const { $, segments } = splitSegments('<p>Hello world</p>Tweet line<br><br>Second line');
        for (const [index, segment] of segments.entries()) {
            insertTranslation($, segment, `T${index} <b>&\nnext`);
        }
        expect($.html()).toBe(`<p>Hello world${translation('T0 &lt;b&gt;&amp;<br>next')}</p>Tweet line${translation('T1 &lt;b&gt;&amp;<br>next')}<br><br>Second line${translation('T2 &lt;b&gt;&amp;<br>next')}`);
    });

    test('ends a line at a <br> inside an inline element', () => {
        const { $, segments } = splitSegments('<p><i>First quoted line.<br>Second quoted line.</i></p>');
        for (const [index, segment] of segments.entries()) {
            insertTranslation($, segment, `T${index}`);
        }
        expect($.html()).toBe(`<p><i>First quoted line.${translation('T0')}<br>Second quoted line.</i>${translation('T1')}</p>`);
        expect(textsOf('<b>Breaking<br>News today</b>')).toEqual(['Breaking', 'News today']);
    });

    test('gives each visual line of a Slashdot summary its own segment', () => {
        const summary =
            '<div class="p">\n \nThe Post <a href="https://example.com/a">reports</a>:\n\n<i>Quote one ends here. </i> <br>\n\n' +
            'A second source <a href="https://example.com/b">adds</a>:\n\n<i>Quote two starts here.  <br> <br>\n\nParagraph three ends it.\n</i> <br>\n</div>';
        expect(textsOf(summary)).toEqual(['The Post reports: Quote one ends here.', 'A second source adds: Quote two starts here.', 'Paragraph three ends it.']);
    });

    test('keeps a sentence whole around inline icons and fine print', () => {
        expect(textsOf('<p>Click the <svg viewBox="0 0 24 24"><title>Star</title><path d="M0 0h24v24H0z"></path></svg> icon to save <small>(beta)</small> your work.</p>')).toEqual(['Click the icon to save your work.']);
    });

    test('translates the text after an author label, not the label', () => {
        const { $, segments } = splitSegments('<a href="https://x.com/writer"><img src="avatar.jpg"><strong>Writer</strong></a>: Hello <b>world</b><br>Next line');
        expect(segments.map((segment) => segment.text)).toEqual(['Hello world', 'Next line']);
        insertTranslation($, segments[0], 'T');
        expect($.html()).toBe(`<a href="https://x.com/writer"><img src="avatar.jpg"><strong>Writer</strong></a>: Hello <b>world</b>${translation('T')}<br>Next line`);
        // A name in the middle of a line belongs to the sentence, and so does a colon that follows no label.
        expect(textsOf('Reported by <a href="https://x.com/alice">Alice</a>: the news')).toEqual(['Reported by Alice: the news']);
        expect(textsOf('<p>:) Great news</p>')).toEqual([':) Great news']);
    });

    test('translates only the post text of a readable tweet, not bylines or links', () => {
        const tweet =
            "<a href='https://x.com/writer'><img width='48' height='48' src='avatar.jpg'><strong>Writer</strong></a>:&ensp;Main text<br clear='both' /><div style='clear: both'></div>" +
            "<div class=\"rsshub-quote\"><blockquote><small><a href='https://x.com/parent'><strong>Parent</strong></a> · <a href='https://x.com/parent/status/1'>2026-09-24 20:42</a></small><br>Parent text</blockquote></div>" +
            '<hr><small>Thu Sep 24 2026 20:48:54 GMT+0800 (China Standard Time)</small>';
        expect(textsOf(tweet)).toEqual(['Main text', 'Parent text']);
    });

    test('leaves out wordless text and, for Chinese targets, text already in Chinese', () => {
        expect(needsTranslation('Herman Jin: ↩️ @j_beacon21 没有分歧呀', 'zh-CN')).toBe(false);
        expect(needsTranslation('Herman Jin: ↩️ @tonyhua64243679 对，eps赠速', 'zh-CN')).toBe(false);
        expect(needsTranslation('Herman Jin: 对', 'zh-CN')).toBe(false);
        expect(needsTranslation('https://x.com/a/status/1 @someone #tag $TSLA 2026 🔥', 'zh-CN')).toBe(false);
        expect(needsTranslation('Photon Capital: I am still long $FORM, $AEHR', 'zh-CN')).toBe(true);
        expect(needsTranslation('I love 小米', 'zh-CN')).toBe(true);
        expect(needsTranslation('今日は東京で会議がありました', 'zh-CN')).toBe(true);
        expect(needsTranslation('Herman Jin: 对', 'en')).toBe(true);
        // The label has words; a translation that comes back unchanged is dropped later.
        expect(needsTranslation('Herman Jin: 🔥🔥', 'en')).toBe(true);
    });

    test('keeps a sentence before a colon, a link or mentions', () => {
        for (const text of [
            'In the last 5 weeks we’ve got news on:',
            'Technical write-up here: https://example.com/write-up',
            'Source code: https://github.com/example/repo',
            'Read the report: https://example.com/report.pdf',
            'Congrats to the whole team: @alice @bob 🎉',
        ]) {
            expect(needsTranslation(text, 'zh-CN'), text).toBe(true);
        }
    });
});

describe('translate parameter', () => {
    test('translates the items left after limit, putting the translated title first', async () => {
        mockGemini();
        const feed = await requestFeed('/test/1?translate=Zh-CN&limit=2');
        expect(feed.items.map((item) => item.title)).toEqual(['译:Title1 | Title1', '译:Title2 | Title2']);
        expect(feed.items[0].content).toBe(`Description1${translation('译:Description1')}`);
        expect(geminiCalls).toHaveLength(1);
        expect(geminiCalls[0]).toMatchObject({ path: '/v1beta/models/gemini-3.8-flash:generateContent', apiKey: 'gemini-test-key', thinking: { thinkingBudget: 0 } });
        expect(geminiCalls[0].texts.toSorted((a, b) => a.localeCompare(b))).toEqual(['Description1', 'Description2', 'Title1', 'Title2']);
    });

    test('shortens a long translated title so that the original still follows it', async () => {
        const { titleLengthLimit } = config;
        // The template middleware cuts titles wider than this after translation, counting 2 for every UTF-16 unit outside ASCII.
        config.titleLengthLimit = 40;
        try {
            mockGemini();
            expect((await requestFeed('/test/long?translate=de')).items[0].title).toBe('译:Long Title Long… | Long Title Long T...');

            // An emoji is never split and counts 4, as its two UTF-16 units do in the template middleware.
            mockGemini({ translate: (text) => (text.startsWith('Long Title') ? `A ${'🔥'.repeat(50)}` : text) });
            expect((await requestFeed('/test/long?translate=fr')).items[0].title).toBe('A 🔥🔥🔥🔥… | Long Title Long T...');

            // A translation that fits next to a short original stays whole.
            mockGemini({ translate: (text) => (text === 'Title1' ? 'A much longer translation' : text) });
            expect((await requestFeed('/test/1?translate=it&limit=1')).items[0].title).toBe('A much longer translation | Title1');
        } finally {
            config.titleLengthLimit = titleLengthLimit;
        }
    });

    test('drops a translation that only changes punctuation or spacing', async () => {
        mockGemini({ translate: (text) => text.replaceAll(':', '：') });
        const item = { title: 'Andrej Karpathy: 🔁 Thariq: http://x.com/i/article/2102', description: '<p>Source code: https://github.com/example/repo</p>' };
        const data = { title: 'Feed', item: [{ ...item }] };
        await translateFeed(data, 'zh-CN');
        expect(geminiCalls).toHaveLength(1);
        expect(data.item[0]).toEqual(item);
    });

    test('skips a post that is only emoji after its author label', async () => {
        mockGemini();
        const description = "<a href='https://x.com/writer'><strong>Writer</strong></a>:&ensp;🔥🔥";
        const data = { title: 'Feed', item: [{ description }] };
        await translateFeed(data, 'en');
        expect(geminiCalls).toHaveLength(0);
        expect(data.item[0].description).toBe(description);
    });

    test('serves repeated fetches from the translation cache', async () => {
        mockGemini();
        await requestFeed('/test/1?translate=ja&limit=1');
        const feed = await requestFeed('/test/1?translate=ja&limit=1');
        expect(feed.items[0].title).toBe('译:Title1 | Title1');
        expect(geminiCalls).toHaveLength(1);
    });

    test('shares one Gemini request between concurrent fetches of the same text', async () => {
        mockGemini();
        const first = { title: 'Feed', item: [{ title: 'Same headline', description: '<p>Same body</p>' }] };
        const second = structuredClone(first);
        await Promise.all([translateFeed(first, 'de'), translateFeed(second, 'de')]);
        expect(geminiCalls).toHaveLength(1);
        expect(second.item[0].title).toBe('译:Same headline | Same headline');
    });

    test('keeps the original text when Gemini fails and translates on the next fetch', async () => {
        mockGemini({ status: 500 });
        const failed = await requestFeed('/test/1?translate=fr&limit=1');
        expect(failed.items[0].title).toBe('Title1');
        expect(failed.items[0].content).toBe('Description1');
        // A server error is not split into halves; ofetch retries the whole batch once.
        expect(geminiCalls.map((call) => call.texts.length)).toEqual([2, 2]);

        mockGemini();
        const recovered = await requestFeed('/test/1?translate=fr&limit=1');
        expect(recovered.items[0].title).toBe('译:Title1 | Title1');
    });

    test('asks again in halves when Gemini leaves an item out of a batch', async () => {
        mockGemini({ answer: (translations, call) => JSON.stringify(call === geminiCalls[0] ? translations.slice(0, -1) : translations) });
        const data = { title: 'Feed', item: [{ title: 'Headline', description: '<p>Line one</p><p>Line two</p><p>Line three</p>' }] };
        await translateFeed(data, 'de');
        expect(geminiCalls.map((call) => call.texts.length)).toEqual([4, 2, 2]);
        expect(data.item[0].title).toBe('译:Headline | Headline');
        expect(data.item[0].description).toBe(`<p>Line one${translation('译:Line one')}</p><p>Line two${translation('译:Line two')}</p><p>Line three${translation('译:Line three')}</p>`);
    });

    test('halves a batch down to single segments while Gemini keeps leaving an item out', async () => {
        mockGemini({ answer: (translations) => JSON.stringify(translations.length > 1 ? translations.slice(0, -1) : translations) });
        const warn = vi.spyOn(logger, 'warn');
        try {
            const data = { title: 'Feed', item: [{ title: 'Headline', description: '<p>Line one</p><p>Line two</p><p>Line three</p>' }] };
            await translateFeed(data, 'de');
            expect(geminiCalls.map((call) => call.texts.length).toSorted((a, b) => a - b)).toEqual([1, 1, 1, 1, 2, 2, 4]);
            expect(data.item[0].title).toBe('译:Headline | Headline');
            expect(data.item[0].description).toBe(`<p>Line one${translation('译:Line one')}</p><p>Line two${translation('译:Line two')}</p><p>Line three${translation('译:Line three')}</p>`);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('leaves untranslated only a segment whose reply stays malformed', async () => {
        // Every reply that includes the second line is cut short, as when Gemini runs out of output tokens.
        mockGemini({
            answer: (translations, call) => {
                const reply = JSON.stringify(translations);
                return call.texts.includes('Line two') ? reply.slice(0, -2) : reply;
            },
        });
        const warn = vi.spyOn(logger, 'warn');
        try {
            const data = { title: 'Feed', item: [{ title: 'Headline', description: '<p>Line one</p><p>Line two</p><p>Line three</p>' }] };
            await translateFeed(data, 'de');
            expect(data.item[0].title).toBe('译:Headline | Headline');
            expect(data.item[0].description).toBe(`<p>Line one${translation('译:Line one')}</p><p>Line two</p><p>Line three${translation('译:Line three')}</p>`);
            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 segments stay untranslated this time: GeminiOutputError: Gemini sent invalid JSON'));
        } finally {
            warn.mockRestore();
        }
    });

    test('logs the reason Gemini gives for rejecting a request', async () => {
        mockGemini({ status: 400, message: 'API key not valid. Please pass a valid API key.' });
        const warn = vi.spyOn(logger, 'warn');
        try {
            await translateFeed({ title: 'Feed', item: [{ title: 'Rejected headline' }] }, 'pt');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Gemini 400: API key not valid. Please pass a valid API key.'));
        } finally {
            warn.mockRestore();
        }
    });

    test('keeps the default thinking of a model that cannot switch it off', async () => {
        vi.stubEnv('GEMINI_MODEL', 'models/gemini-thinking-only');
        mockGemini({ status: (call) => (call.thinking ? 400 : 200), message: 'Budget 0 is invalid. This model only works in thinking mode.' });
        const first = { title: 'Feed', item: [{ title: 'First headline' }] };
        const second = { title: 'Feed', item: [{ title: 'Second headline' }] };
        await translateFeed(first, 'es');
        await translateFeed(second, 'es');
        expect(geminiCalls.map((call) => call.thinking)).toEqual([{ thinkingBudget: 0 }, undefined, undefined]);
        expect(geminiCalls[0].path).toBe('/v1beta/models/gemini-thinking-only:generateContent');
        expect(second.item[0].title).toBe('译:Second headline | Second headline');
    });

    test('sends only the lines that are not in the target language yet', async () => {
        mockGemini();
        const data = { title: 'Feed', item: [{ title: 'Herman Jin: ↩️ @j_beacon21 没有分歧呀', description: '<p>中文内容不需要翻译</p><p>But this English line does</p>' }] };
        await translateFeed(data, 'zh-CN');
        expect(geminiCalls.map((call) => call.texts)).toEqual([['But this English line does']]);
        expect(data.item[0].title).toBe('Herman Jin: ↩️ @j_beacon21 没有分歧呀');
        expect(data.item[0].description).toBe(`<p>中文内容不需要翻译</p><p>But this English line does${translation('译:But this English line does')}</p>`);
    });

    test('serves the feed untranslated when the translation cache fails', async () => {
        mockGemini();
        const get = vi.spyOn(cache, 'get').mockRejectedValue(new Error('cache is down'));
        try {
            const response = await app.request('/test/1?translate=it&limit=1');
            expect(response.status).toBe(200);
            expect((await parser.parseString(await response.text())).items[0].title).toBe('Title1');
        } finally {
            get.mockRestore();
        }
    });

    test('keeps a fetched translation that the cache fails to store', async () => {
        mockGemini();
        const set = vi.spyOn(cache, 'set').mockRejectedValue(new Error('cache is full'));
        const warn = vi.spyOn(logger, 'warn');
        try {
            const data = { title: 'Feed', item: [{ title: 'Uncached headline' }] };
            await translateFeed(data, 'nl');
            expect(data.item[0].title).toBe('译:Uncached headline | Uncached headline');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache is full'));
        } finally {
            set.mockRestore();
            warn.mockRestore();
        }
        // Nothing was stored or left in flight, so the next fetch asks Gemini again.
        await translateFeed({ title: 'Feed', item: [{ title: 'Uncached headline' }] }, 'nl');
        expect(geminiCalls).toHaveLength(2);
    });

    test('explains an invalid language and a missing API key', async () => {
        const invalid = await app.request('/test/1?translate=zh_CN_1');
        expect(invalid.status).toBe(503);
        expect(await invalid.text()).toContain('translate expects a language tag such as zh-CN');

        vi.stubEnv('GEMINI_API_KEY', '');
        const missingKey = await app.request('/test/1?translate=zh-CN');
        expect(missingKey.status).toBe(503);
        expect(await missingKey.text()).toContain('translate requires GEMINI_API_KEY');
        expect(geminiCalls).toHaveLength(0);
    });
});
