import { Global, Module } from '@nestjs/common';
import { GeoService } from './geo.service';
import { ToponymService } from './toponym.service';

@Global()
@Module({
  providers: [ToponymService, GeoService],
  exports: [ToponymService, GeoService],
})
export class GeoModule {}
