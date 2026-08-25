import * as cheerio from 'cheerio';

export type ScrapedMessage = {
  telegramId: number;
  text: string;
  replyToTelegramId?: number;
  replyPreview?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  date: Date;
};

type CheerioRoot = ReturnType<typeof cheerio.load>;

function parseMessageId($: CheerioRoot, element: any): number | null {
  const dataId = $(element).find('.tgme_widget_message').attr('data-post');
  if (!dataId) return null;
  const messageId = parseInt(dataId.split('/').pop() || '0', 10);
  return Number.isFinite(messageId) && messageId > 0 ? messageId : null;
}

export function parseChannelHtml(html: string, afterTelegramId?: number): {
  messages: ScrapedMessage[];
  maxTelegramId?: number;
} {
  const $ = cheerio.load(html);
  const wraps = $('.tgme_widget_message_wrap').toArray();
  if (wraps.length === 0) return { messages: [] };

  const firstId = parseMessageId($, wraps[0]);
  const lastId = parseMessageId($, wraps[wraps.length - 1]);
  const newestFirst = firstId != null && lastId != null && firstId >= lastId;
  const ordered = newestFirst ? wraps : [...wraps].reverse();

  const messages: ScrapedMessage[] = [];
  let maxTelegramId = afterTelegramId ?? 0;

  for (const element of ordered) {
    const messageId = parseMessageId($, element);
    if (messageId == null) continue;
    if (messageId > maxTelegramId) maxTelegramId = messageId;
    if (afterTelegramId && messageId <= afterTelegramId) break;

    const msgNode = $(element).find('.tgme_widget_message');
    const replyNode = msgNode.find('a.tgme_widget_message_reply').first();
    const replyHref = replyNode.attr('href') ?? '';
    const replyIdRaw = parseInt(replyHref.split('/').pop() || '', 10);
    const replyToTelegramId = Number.isFinite(replyIdRaw) && replyIdRaw > 0 ? replyIdRaw : undefined;
    const replyPreview = replyNode.find('.js-message_reply_text').text().trim() || undefined;

    const textNode = msgNode.find('.tgme_widget_message_text.js-message_text').first();
    textNode.find('.tgme_widget_message_reply').remove();
    textNode.find('br').replaceWith('\n');
    const text = textNode.text().trim();
    const timeStr = msgNode.find('time').attr('datetime');
    if (!text || !timeStr) continue;

    messages.push({
      telegramId: messageId,
      text,
      replyToTelegramId,
      replyPreview,
      date: new Date(timeStr),
    });
  }

  return {
    messages,
    maxTelegramId: maxTelegramId > 0 ? maxTelegramId : undefined,
  };
}
