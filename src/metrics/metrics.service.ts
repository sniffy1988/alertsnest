import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  channelCount = 0;
  lastScrapeAt: string | null = null;
  bufferSize = 0;
  lastBatchMs: number | null = null;
  lastAlertAt: string | null = null;
  ollamaOk: boolean | null = null;
  scrapeActive = false;
  whatsappReady = false;
  viberReady = false;

  snapshot() {
    return {
      channelCount: this.channelCount,
      lastScrapeAt: this.lastScrapeAt,
      bufferSize: this.bufferSize,
      lastBatchMs: this.lastBatchMs,
      lastAlertAt: this.lastAlertAt,
      ollamaOk: this.ollamaOk,
      scrapeActive: this.scrapeActive,
      notify: {
        telegram: true,
        whatsapp: this.whatsappReady,
        viber: this.viberReady,
      },
    };
  }
}
