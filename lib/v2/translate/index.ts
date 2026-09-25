import type { MiddlewareHandler } from 'hono';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import md5 from '@/utils/md5';

import { insertTranslation, needsTranslation, splitSegments } from './bilingual';
import { GeminiOutputError, geminiSettings, translateWithGemini } from './gemini';

// `?translate=<BCP 47 tag>` (e.g. zh-CN) adds a Gemini translation under every line of each item and in front of its title.
// Requires GEMINI_API_KEY; GEMINI_MODEL and GEMINI_API_ENDPOINT are optional.

const cacheMaxAge = 7 * 24 * 60 * 60;
// Gemini Flash takes about 4 s for a 3000-character batch, so a whole uncached feed is translated by small batches side by side.
const maxBatchSegments = 40;
const maxBatchCharacters = 3000;
const maxConcurrentRequests = 8;
// Translations still running after this keep going in the background and are served from cache on the next fetch.
const responseBudget = 20000;

const inflight = new Map<string, Promise<string | undefined>>();

let running = 0;
const queued: Array<() => void> = [];
const withRequestSlot = async <T>(task: () => Promise<T>) => {
    if (running < maxConcurrentRequests) {
        running++;
    } else {
        // A finishing request hands its slot straight to the next queued one.
        await new Promise<void>((resolve) => {
            queued.push(resolve);
        });
    }
    try {
        return await task();
    } finally {
        const next = queued.shift();
        if (next) {
            next();
        } else {
            running--;
        }
    }
};

const toBatches = (texts: string[]) => {
    const batches: string[][] = [];
    let batch: string[] = [];
    let size = 0;
    for (const text of texts) {
        if (batch.length && (batch.length === maxBatchSegments || size + text.length > maxBatchCharacters)) {
            batches.push(batch);
            batch = [];
            size = 0;
        }
        batch.push(text);
        size += text.length;
    }
    if (batch.length) {
        batches.push(batch);
    }
    return batches;
};

const readCachedTranslation = async (key: string): Promise<string | undefined> => {
    const value = await cache.get(key, false);
    if (!value) {
        return;
    }
    try {
        const translation: unknown = JSON.parse(value);
        if (typeof translation === 'string') {
            return translation;
        }
    } catch {
        // A malformed entry is simply translated again.
    }
};

// Resolves to one translation per text, or undefined where a text stays untranslated this time.
const requestTranslations = async (batch: string[], lang: string): Promise<Array<string | undefined>> => {
    try {
        return await withRequestSlot(() => translateWithGemini(batch, lang));
    } catch (error) {
        // The model occasionally merges or drops an item of a long batch; halving realigns it, so only a text that fails on its own stays untranslated.
        // Each half waits for a slot of its own; the failed request has already handed its slot back.
        if (error instanceof GeminiOutputError && batch.length > 1) {
            logger.debug(`translate: asking again for ${batch.length} segments in halves: ${error}`);
            const middle = Math.ceil(batch.length / 2);
            const halves = await Promise.all([requestTranslations(batch.slice(0, middle), lang), requestTranslations(batch.slice(middle), lang)]);
            return halves.flat();
        }
        logger.warn(`translate: ${batch.length} segments stay untranslated this time: ${error}`);
        return Array.from<string | undefined>({ length: batch.length });
    }
};

const storeTranslation = async (key: string, request: Promise<Array<string | undefined>>, index: number) => {
    try {
        const translation = (await request)[index];
        if (translation === undefined) {
            return;
        }
        try {
            await cache.set(key, JSON.stringify(translation), cacheMaxAge);
        } catch (error) {
            // The translation still serves this response; the next fetch asks Gemini again.
            logger.warn(`translate: a translation could not be cached: ${error}`);
        }
        return translation;
    } finally {
        inflight.delete(key);
    }
};

const translateTexts = async (texts: string[], lang: string) => {
    const { model } = geminiSettings();
    const keyOf = (text: string) => `translate:gemini:${model}:${lang}:${md5(text)}`;
    const translations = new Map<string, string>();
    const missing: string[] = [];
    await Promise.all(
        texts.map(async (text) => {
            const translation = await readCachedTranslation(keyOf(text));
            if (translation === undefined) {
                missing.push(text);
            } else {
                translations.set(text, translation);
            }
        })
    );

    const batches = toBatches(missing.filter((text) => !inflight.has(keyOf(text))));
    for (const batch of batches) {
        const request = requestTranslations(batch, lang);
        for (const [index, text] of batch.entries()) {
            const key = keyOf(text);
            inflight.set(key, storeTranslation(key, request, index));
        }
    }

    const settled = Promise.allSettled(
        missing.map(async (text) => {
            const translation = await inflight.get(keyOf(text));
            if (translation !== undefined) {
                translations.set(text, translation);
            }
        })
    );
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, responseBudget);
    });
    await Promise.race([settled, budget]);
    clearTimeout(timer);
    return translations;
};

// A "translation" that only changes spacing, punctuation (such as full-width colons) or case adds nothing.
const comparable = (text: string) => text.replaceAll(/[\s\p{P}]/gu, '').toLowerCase();

// The template middleware cuts titles wider than TITLE_LENGTH_LIMIT after this one runs, counting 1 for an ASCII character and 2 for any other UTF-16 unit.
const widthOf = (text: string) => {
    let width = 0;
    for (const char of text) {
        width += Buffer.byteLength(char) === 1 ? 1 : char.length * 2;
    }
    return width;
};

// The translation takes at most half of the title limit, or all that a short original leaves, so the template shortens the original instead of dropping it.
const fitTitle = (translation: string, original: string) => {
    const limit = config.titleLengthLimit;
    const room = Math.max(limit / 2, limit - ' | '.length - widthOf(original));
    if (widthOf(translation) <= room) {
        return translation;
    }
    let fitted = '';
    let width = widthOf('…');
    // By code point, so an emoji is never split.
    for (const char of translation) {
        width += widthOf(char);
        if (width > room) {
            break;
        }
        fitted += char;
    }
    return `${fitted.trimEnd()}…`;
};

export const translateFeed = async (data: Data, lang: string) => {
    const items = (data.item ?? []).map((item) => ({ item, title: item.title?.replaceAll(/\s+/g, ' ').trim() ?? '', ...splitSegments(item.description ?? '') }));
    const texts = new Set(items.flatMap(({ title, segments }) => [title, ...segments.map((segment) => segment.text)]).filter((text) => needsTranslation(text, lang)));
    if (!texts.size) {
        return;
    }

    const translations = await translateTexts([...texts], lang);
    const translationOf = (text: string) => {
        const translation = translations.get(text);
        return translation && comparable(translation) !== comparable(text) ? translation : undefined;
    };
    for (const { item, title, $, segments } of items) {
        const translatedTitle = translationOf(title);
        if (translatedTitle) {
            item.title = `${fitTitle(translatedTitle, title)} | ${item.title}`;
        }
        let translated = false;
        for (const segment of segments) {
            const translation = translationOf(segment.text);
            if (!translation) {
                continue;
            }
            insertTranslation($, segment, translation);
            translated = true;
        }
        if (translated) {
            item.description = $.html();
        }
    }
};

const parseLanguage = (value: string) => {
    let lang: string | undefined;
    try {
        lang = Intl.getCanonicalLocales(value.replaceAll('_', '-'))[0];
    } catch {
        lang = undefined;
    }
    if (!lang) {
        throw new InvalidParameterError(`translate expects a language tag such as zh-CN, got "${value}"`);
    }
    if (!geminiSettings().apiKey) {
        throw new ConfigNotFoundError('translate requires GEMINI_API_KEY to be set');
    }
    return lang;
};

const middleware: MiddlewareHandler = async (ctx, next) => {
    const target = ctx.req.query('translate');
    const lang = target ? parseLanguage(target) : undefined;

    await next();

    const data: Data | undefined = ctx.get('data');
    if (lang && data?.item?.length) {
        try {
            await translateFeed(data, lang);
        } catch (error) {
            // Translation is an extra layer; a cache or parsing failure must not break the feed itself.
            logger.warn(`translate: serving ${ctx.req.path} untranslated: ${error}`);
        }
    }
};

export default middleware;
