import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import type { AnyNode, Element, ParentNode } from 'domhandler';
import { escapeText } from 'entities';

// Elements that lay out on their own line; the text inside each gets its own translation.
const blockTags = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'caption',
    'center',
    'dd',
    'details',
    'dialog',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'p',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);

// Line breaks, embedded media and code blocks end a line and are never translated.
const lineBreakTags = new Set(['audio', 'br', 'canvas', 'embed', 'hr', 'iframe', 'object', 'picture', 'pre', 'video']);

// Controls, scripts, graphics and fine print (bylines, timestamps) are never translated either, but the line runs on around them.
const excludedTags = new Set(['button', 'input', 'math', 'noscript', 'script', 'select', 'small', 'style', 'svg', 'template', 'textarea']);

const elementTypes = new Set<string>(['tag', 'script', 'style']);
const isElement = (node: AnyNode): node is Element => elementTypes.has(node.type);

// An author label as in `<a …><strong>Name</strong></a>:&ensp;text` of the readable tweet template.
const labelColon = /^\s*[:：]/;
const isLabel = (node: Element) => node.next?.type === 'text' && labelColon.test(node.next.data);

export interface Segment {
    text: string;
    // The block, or the root, that holds the line.
    parent: ParentNode;
    // The element that ends the line; without one the line runs to the end of `parent`.
    boundary?: Element;
}

// Inline elements are transparent: a line collects their text in document order until a line break or the start or end of a block.
export const splitSegments = (html: string) => {
    const $ = load(html, null, false);
    const segments: Segment[] = [];
    let line = '';
    const endLine = (parent: ParentNode, boundary?: Element) => {
        const text = line.replaceAll(/\s+/g, ' ').trim();
        if (text) {
            segments.push({ text, parent, boundary });
        }
        line = '';
    };
    const visit = (node: ParentNode, block: ParentNode) => {
        let label: Element | undefined;
        for (const child of node.children) {
            if (child.type === 'text') {
                line += label && child.prev === label ? child.data.replace(labelColon, '') : child.data;
            } else if (isElement(child) && !excludedTags.has(child.name)) {
                if (lineBreakTags.has(child.name)) {
                    endLine(block, child);
                } else if (blockTags.has(child.name)) {
                    endLine(block, child);
                    visit(child, child);
                    endLine(child);
                } else if (!line.trim() && isLabel(child)) {
                    // The translation then does not repeat the name; it still goes at the end of the line.
                    label = child;
                } else {
                    visit(child, block);
                }
            }
        }
    };
    const root = $.root()[0];
    visit(root, root);
    endLine(root);
    return { $, segments };
};

// Cheerio cannot insert after a text node, so the translation goes before the line's boundary or at the end of its parent.
// Opacity rather than a grey keeps it secondary yet readable on light and dark backgrounds alike.
// `font-style: normal` keeps a translation upright when it lands inside an italic quote, as in Slashdot summaries.
export const insertTranslation = ($: CheerioAPI, segment: Segment, translation: string) => {
    const lines = translation.split('\n').map((line) => escapeText(line));
    const html = `<br><span class="rsshub-translation" style="opacity: 0.7; font-style: normal;">${lines.join('<br>')}</span>`;
    if (segment.boundary) {
        $(segment.boundary).before(html);
    } else {
        $(segment.parent).append(html);
    }
};

const ignoredTokens = /https?:\/\/\S+|[@#$][\p{L}\p{N}_]+/gu;
// A leading label such as the author name in "Name: text" says nothing about the language of the text.
// It still counts as words: in "Source code: https://…" the label is all there is to translate.
const leadingLabel = /^[^:：]{1,40}[:：]/u;

// About two Chinese characters carry the meaning of one Latin word; kana marks Japanese text.
const isMostlyChinese = (text: string) => {
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latinWords = text.match(/\p{Script=Latin}+/gu)?.length ?? 0;
    return han > 0 && han >= latinWords * 2 && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
};

// Skips text without words (links, mentions, tickers, numbers, emoji) and, for Chinese targets, text that is already Chinese.
export const needsTranslation = (text: string, lang: string) => {
    const body = text.replaceAll(ignoredTokens, ' ');
    return /\p{L}{2}|\p{Script=Han}/u.test(body) && !(lang.startsWith('zh') && isMostlyChinese(body.replace(leadingLabel, ' ')));
};
