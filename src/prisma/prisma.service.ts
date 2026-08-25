import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SEED_CHANNELS } from './seed-channels';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    const count = await this.channel.count();
    if (count > 0) {
      this.logger.log(`channels already in DB: ${count}`);
      return;
    }
    await this.channel.createMany({ data: [...SEED_CHANNELS] });
    this.logger.log(`seeded channels: ${SEED_CHANNELS.map((c) => '@' + c.link).join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
