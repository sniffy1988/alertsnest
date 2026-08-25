import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
