import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeoService } from '../geo/geo.service';
import type { Locale } from '../common/i18n';

export type SubscriberIdentity = {
  telegramId?: bigint;
  whatsappPhone?: string;
  viberId?: string;
  firstName?: string | null;
  locale?: string;
};

@Injectable()
export class SubscriberService {
  private readonly logger = new Logger(SubscriberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  async saveLocation(
    identity: SubscriberIdentity,
    lat: number,
    lon: number,
  ): Promise<{ label: string; oblastCode: string; locale: string; firstName: string | null }> {
    const area = this.geo.resolveUserArea(lat, lon);
    const locale = (identity.locale as Locale) || 'ua';
    const user = await this.upsert(identity, {
      lat,
      lon,
      oblastCode: area.oblastCode,
      locationUpdatedAt: new Date(),
      locale,
    });
    this.logger.log(
      `geo user=${user.id} tg=${user.telegramId ?? '-'} wa=${user.whatsappPhone ?? '-'} ` +
        `vb=${user.viberId ?? '-'} ${lat.toFixed(5)},${lon.toFixed(5)} ${area.label}`,
    );
    return {
      label: area.label,
      oblastCode: area.oblastCode,
      locale: user.locale,
      firstName: user.firstName,
    };
  }

  async upsert(
    identity: SubscriberIdentity,
    extra: {
      lat?: number;
      lon?: number;
      oblastCode?: string;
      locationUpdatedAt?: Date;
      locale?: string;
    } = {},
  ) {
    const existing = await this.find(identity);
    const locale = extra.locale ?? identity.locale ?? existing?.locale ?? 'ua';
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          telegramId: identity.telegramId ?? undefined,
          whatsappPhone: identity.whatsappPhone ?? undefined,
          viberId: identity.viberId ?? undefined,
          firstName: identity.firstName ?? undefined,
          locale,
          ...extra,
        },
      });
    }
    return this.prisma.user.create({
      data: {
        telegramId: identity.telegramId ?? null,
        whatsappPhone: identity.whatsappPhone ?? null,
        viberId: identity.viberId ?? null,
        firstName: identity.firstName ?? null,
        locale,
        ...extra,
      },
    });
  }

  private find(identity: SubscriberIdentity) {
    if (identity.telegramId != null) {
      return this.prisma.user.findUnique({ where: { telegramId: identity.telegramId } });
    }
    if (identity.whatsappPhone) {
      return this.prisma.user.findUnique({ where: { whatsappPhone: identity.whatsappPhone } });
    }
    if (identity.viberId) {
      return this.prisma.user.findUnique({ where: { viberId: identity.viberId } });
    }
    return Promise.resolve(null);
  }
}
