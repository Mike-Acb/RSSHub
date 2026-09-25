import dayjs from 'dayjs';

import { parseDate } from '@/utils/parse-date';

interface ContextStatus {
    user: { name: string; screen_name: string };
    id_str?: string;
    conversation_id_str?: string;
    created_at: string;
    full_text?: string;
    text?: string;
}

interface ContextOptions {
    readable: boolean;
    authorNameBold: boolean;
    showEmojiForRetweetAndReply: boolean;
    showSymbolForRetweetAndReply: boolean;
}

interface ContextHelpers {
    formatText: (status: ContextStatus) => string;
    formatMedia: (status: ContextStatus) => string;
    generatePicsPrefix: (status: ContextStatus) => string;
    separator: string;
}

const link = (href: string, content: string) => `<a href='${href}' target='_blank' rel='noopener noreferrer'>${content}</a>`;

// Reply parents render as a compact thread: one byline linking the author and the post, then the post itself.
export const renderConversationContext = (statuses: ContextStatus[], options: ContextOptions, helpers: ContextHelpers) => {
    let html = '';
    let picsPrefix = '';
    let title = '';
    for (const status of statuses) {
        status.full_text ||= status.text;
        const text = helpers.formatText(status);
        const profile = `https://x.com/${status.user.screen_name}`;
        const name = options.authorNameBold ? `<strong>${status.user.name}</strong>` : status.user.name;
        const time = dayjs(parseDate(status.created_at)).format('YYYY-MM-DD HH:mm');
        const post = `<small>${link(profile, name)} · ${link(`${profile}/status/${status.id_str || status.conversation_id_str}`, time)}</small><br>${text}${helpers.formatMedia(status)}`;
        html += options.readable
            ? `<div class="rsshub-quote"><blockquote style='margin:8px 0 0;padding:2px 0 2px 12px;border-left:3px solid #80808060;'>${post}</blockquote></div>`
            : `${helpers.separator}<div class="rsshub-quote">${post}</div>`;
        picsPrefix += helpers.generatePicsPrefix(status);
        title += `${options.showEmojiForRetweetAndReply ? ' 💬 ' : options.showSymbolForRetweetAndReply ? ' RT ' : ''}${status.user.name}: ${text}`;
    }
    if (html && options.readable) {
        html = `<br clear='both' /><div style='clear: both'></div>${html}`;
    }
    return { html, picsPrefix, title };
};
