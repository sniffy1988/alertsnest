import type { ConfigService } from '@nestjs/config';

export function channelInviteHints(config: ConfigService): string[] {
  const waNumber = (config.get<string>('WHATSAPP_DISPLAY_NUMBER') || '').replace(/\D/g, '');
  const waReady = Boolean(
    (config.get<string>('WHATSAPP_TOKEN') || '').trim() &&
      (config.get<string>('WHATSAPP_PHONE_NUMBER_ID') || '').trim(),
  );
  const viberUri = (config.get<string>('VIBER_URI') || '').trim();
  const viberReady = Boolean((config.get<string>('VIBER_AUTH_TOKEN') || '').trim());

  const lines: string[] = [];
  if (waNumber) lines.push(`WhatsApp: https://wa.me/${waNumber}`);
  else if (waReady) lines.push('WhatsApp');
  if (viberUri) lines.push(`Viber: viber://pa?chatURI=${viberUri}`);
  else if (viberReady) lines.push('Viber');
  return lines;
}
