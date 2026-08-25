import { Global, Module } from '@nestjs/common';
import { GeoService } from './geo.service';
import { ToponymService } from './toponym.service';
import { CorrectionService } from './correction.service';

@Global()
@Module({
  providers: [ToponymService, GeoService, CorrectionService],
  exports: [ToponymService, GeoService, CorrectionService],
})
export class GeoModule {}
