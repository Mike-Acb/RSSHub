import { FetchError } from 'ofetch';

import ofetch from '@/utils/ofetch';

export const geminiSettings = () => ({
    apiKey: process.env.GEMINI_API_KEY,
    model: (process.env.GEMINI_MODEL || 'gemini-3.8-flash').replace(/^models\//, ''),
    endpoint: (process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
});

interface GenerateContentResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
}

const instruction = (lang: string) => {
    const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
    return [
        `Translate every string in the JSON array sent by the user into ${language} (${lang}).`,
        'Reply with a JSON array of strings with exactly the same length and order, where each item is the translation of the input item at the same index.',
        'Keep line breaks, URLs, @mentions, #hashtags, emoji, numbers, code and the names of people, products and organizations unchanged unless a widely used translation exists.',
        'Translate faithfully without adding, merging, splitting or explaining anything.',
        `If an item is already written in ${language}, reply with an empty string for that item.`,
    ].join('\n');
};

const isRejected = (error: unknown): error is FetchError => error instanceof FetchError && error.statusCode === 400;

// Gemini explains a rejected request (an invalid key, a retired model) in the response body only.
const withReason = (error: unknown) => {
    if (!(error instanceof FetchError) || typeof error.data?.error?.message !== 'string') {
        return error;
    }
    return new Error(`Gemini ${error.statusCode}: ${error.data.error.message}`, { cause: error });
};

// Thinking only slows translation down, so it is switched off. Models that cannot switch it off (Pro, some Flash-Lite) reject that and keep their default thinking from then on.
const thinkingKept = new Set<string>();

const generateContent = async (texts: string[], lang: string, thinkingOff: boolean) => {
    const { apiKey, model, endpoint } = geminiSettings();
    return await ofetch<GenerateContentResponse>(`${endpoint}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey ?? '' },
        body: {
            systemInstruction: { parts: [{ text: instruction(lang) }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(texts) }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
                ...(thinkingOff && { thinkingConfig: { thinkingBudget: 0 } }),
            },
        },
        retry: 1,
        // A rejected request (400) fails the same way when repeated.
        retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
        timeout: 60000,
    });
};

const generate = async (texts: string[], lang: string) => {
    const { model } = geminiSettings();
    if (thinkingKept.has(model)) {
        return await generateContent(texts, lang, false);
    }
    try {
        return await generateContent(texts, lang, true);
    } catch (error) {
        if (!isRejected(error)) {
            throw error;
        }
        const response = await generateContent(texts, lang, false);
        thinkingKept.add(model);
        return response;
    }
};

// Gemini answered, but not with one translation per text. Unlike a failed request, a smaller batch may well succeed.
export class GeminiOutputError extends Error {
    name = 'GeminiOutputError';
}

export const translateWithGemini = async (texts: string[], lang: string): Promise<string[]> => {
    let response: GenerateContentResponse;
    try {
        response = await generate(texts, lang);
    } catch (error) {
        throw withReason(error);
    }
    const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
    const output = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
    let translations: unknown;
    try {
        translations = output ? JSON.parse(output) : undefined;
    } catch (error) {
        // Output cut short, as by MAX_TOKENS, ends in the middle of the array.
        throw new GeminiOutputError(`Gemini sent invalid JSON for ${texts.length} segments (${reason ?? 'no finish reason'})`, { cause: error });
    }
    if (!Array.isArray(translations) || translations.length !== texts.length || translations.some((translation) => typeof translation !== 'string')) {
        throw new GeminiOutputError(`Gemini translated ${Array.isArray(translations) ? translations.length : 0} of ${texts.length} segments (${reason ?? 'mismatched output'})`);
    }
    return translations;
};
