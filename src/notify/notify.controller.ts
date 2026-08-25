import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WhatsappService } from './whatsapp.service';
import { ViberService } from './viber.service';

@Controller()
export class NotifyController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly viberService: ViberService,
  ) {}

  @Get('webhooks/whatsapp')
  verifyWhatsapp(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    if (this.whatsappService.verifyWebhook(mode, token)) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  }

  @Post('webhooks/whatsapp')
  @HttpCode(200)
  async whatsapp(@Body() body: Parameters<WhatsappService['handleWebhook']>[0]): Promise<void> {
    await this.whatsappService.handleWebhook(body);
  }

  @Post('webhooks/viber')
  @HttpCode(200)
  async viberHook(@Body() body: Parameters<ViberService['handleWebhook']>[0]): Promise<void> {
    await this.viberService.handleWebhook(body);
  }
}
