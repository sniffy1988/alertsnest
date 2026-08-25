import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ToponymService } from './toponym.service';
import { extractRaionPhrase, foldUa } from './place-match';

export type CorrectionResult =
  | { ok: true; messageId: number; place: string; lat: number; lon: number; was: string; text: string }
  | { ok: false; reason: 'none' | 'bad' | 'unknown_target' | 'foreign' };

@Injectable()
export class CorrectionService {
  private readonly logger = new Logger(CorrectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly toponyms: ToponymService,
  ) {}

  async latestMessageId(): Promise<number | null> {
    const row = await this.prisma.alertDelivery.findFirst({
      orderBy: { sentAt: 'desc' },
      select: { messageId: true },
    });
    return row?.messageId ?? null;
  }

  async apply(messageId: number | null, rawName: string): Promise<CorrectionResult> {
    const name = rawName.trim();
    if (name.length < 2) return { ok: false, reason: 'bad' };
    const id = messageId ?? (await this.latestMessageId());
    if (id == null) return { ok: false, reason: 'none' };

    const message = await this.prisma.message.findUnique({
      where: { id },
      include: { places: true, analysis: true, channel: true },
    });
    if (!message) return { ok: false, reason: 'none' };

    const was = message.places.map((p) => p.name).filter(Boolean).join(', ') || '—';
    const aliases = this.wrongLabels(message);
    const explained = await this.toponyms.explain(aliases[0] ?? name, name);
    if (!explained.ok) return { ok: false, reason: explained.reason };
    for (const alias of aliases.slice(1)) {
      if (foldUa(alias) === foldUa(explained.place)) continue;
      await this.toponyms.explain(alias, explained.place);
    }

    await this.prisma.threatPlace.deleteMany({ where: { messageId: id } });
    await this.prisma.threatPlace.create({
      data: {
        messageId: id,
        name: explained.place,
        lat: explained.lat,
        lon: explained.lon,
        oblastCode: foldUa(explained.place),
        matchType: 'settlement',
      },
    });

    this.logger.log(`corrected msg ${id}: ${was} → ${explained.place}`);
    return {
      ok: true,
      messageId: id,
      place: explained.place,
      lat: explained.lat,
      lon: explained.lon,
      was,
      text: message.message,
    };
  }

  async applyRaionNotStreet(messageId: number | null): Promise<CorrectionResult> {
    const id = messageId ?? (await this.latestMessageId());
    if (id == null) return { ok: false, reason: 'none' };
    const message = await this.prisma.message.findUnique({ where: { id } });
    if (!message) return { ok: false, reason: 'none' };
    const raion = extractRaionPhrase(message.message);
    if (!raion) return { ok: false, reason: 'bad' };
    return this.apply(id, raion);
  }

  private wrongLabels(message: {
    message: string;
    places: Array<{ name: string }>;
    analysis: { rawJson: string } | null;
  }): string[] {
    const out = new Set<string>(message.places.map((p) => p.name.trim()).filter((s) => s.length >= 2));
    if (message.analysis?.rawJson) {
      try {
        const raw = JSON.parse(message.analysis.rawJson) as { places?: unknown };
        if (Array.isArray(raw.places)) {
          for (const item of raw.places) {
            if (typeof item === 'string' && item.trim().length >= 2) out.add(item.trim());
          }
        }
      } catch {
        /* ignore */
      }
    }
    const raion = extractRaionPhrase(message.message);
    if (raion) out.add(raion);
    return [...out];
  }
}
