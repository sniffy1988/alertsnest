import { Controller, Get } from '@nestjs/common';
import { MetricsService } from './metrics/metrics.service';

@Controller()
export class HealthController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  root() {
    return { ok: true };
  }

  @Get('health')
  health() {
    return this.metrics.snapshot();
  }
}
