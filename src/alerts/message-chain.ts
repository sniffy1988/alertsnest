import { foldUa } from '../geo/place-match';

export type ChainMessage = {
  telegramId: number;
  text: string;
  replyToTelegramId?: number | null;
  date: Date;
};

export type ResolvedChain = {
  context: string[];
  rootTelegramId: number;
  trackLost: boolean;
  continuation: boolean;
};

export function isTrackLost(text: string): boolean {
  const n = foldUa(text);
  return /не спостер|не наблюда|не видно|втрачено|потерян|не фикс|зник з|пропал|больше не фикс|бильше не фикс/.test(
    n,
  );
}

export function leftOblast(text: string): boolean {
  const n = foldUa(text);
  return /вилет|вылет/.test(n) && /(з област|с област|в полтав|на полтав|полтавськ|полтавск)/.test(n);
}

export function isEtaOnly(text: string): boolean {
  const n = foldUa(text);
  return /підлітн|подлетн|підлітний час|eta/.test(n) && !/\b(дали|далее|курс)\b/.test(n);
}

export function isNoisePost(text: string): boolean {
  const n = foldUa(text);
  if (/(видбий|відбій|отбой|укриття знят|укрытие снят|все чисто|усе чисто)/.test(n)) {
    return false;
  }
  if (/monobank|privatbank|send monobank|підтримка по бажан|поддержка по желанию|картка|конверт/.test(n)) {
    return true;
  }
  const stripped = n.replace(/підпишись на схід/g, '').trim();
  return stripped.length < 8;
}

export function isContinuation(text: string): boolean {
  if (isTrackLost(text) || leftOblast(text) || isEtaOnly(text)) return true;
  const n = foldUa(text);
  return (
    /^(дали|далее|дальше курс|курс на|наступн|потом |на [а-я]{4,})/.test(n) ||
    /\b(дали|далее|дальше курс)\b/.test(n)
  );
}

export function resolveChainFromKnown(
  current: ChainMessage,
  byTelegramId: Map<number, ChainMessage>,
  recentBefore: ChainMessage[],
): ResolvedChain {
  const walked: ChainMessage[] = [];
  const seen = new Set<number>([current.telegramId]);
  let replyId = current.replyToTelegramId ?? null;
  while (replyId && walked.length < 8) {
    if (seen.has(replyId)) break;
    seen.add(replyId);
    const prev = byTelegramId.get(replyId);
    if (!prev) break;
    walked.push(prev);
    replyId = prev.replyToTelegramId ?? null;
  }

  let chain = walked.slice().reverse();
  if (chain.length === 0 && isContinuation(current.text) && recentBefore.length) {
    chain = recentBefore.slice(-6);
  }

  return {
    context: chain.map((m) => m.text),
    rootTelegramId: chain[0]?.telegramId ?? current.telegramId,
    trackLost: isTrackLost(current.text) || leftOblast(current.text),
    continuation: chain.length > 0 || isContinuation(current.text),
  };
}
