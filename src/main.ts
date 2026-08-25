import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

mkdirSync('data', { recursive: true });
const dbFile = process.env.DATABASE_URL?.replace(/^file:/, '');
if (dbFile?.startsWith('/')) mkdirSync(dirname(dbFile), { recursive: true });

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
    rawBody: true,
  });
  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port);
  logger.log(`HTTP listening on :${port}  health=/health`);
}

void bootstrap();
