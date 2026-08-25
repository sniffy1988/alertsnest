import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { GeoService } from '../geo/geo.service';
import { ToponymService } from '../geo/toponym.service';
import { parsePlaceAlias } from '../geo/place-alias';
import { channelInviteHints } from '../notify/invite-links';
import { escapeHtml, previewMessage } from '../common/text';
import { t, type Locale } from '../common/i18n';

type WaitKind = 'channel' | 'area' | 'place';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Bot | null = null;
  private readonly adminIds: Set<string>;
  private readonly wait = new Map<number, WaitKind>();
  private readonly placeDraft = new Map<number, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly toponyms: ToponymService,
  ) {
    this.adminIds = new Set(
      (this.config.get<string>('TELEGRAM_ADMIN_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token === 'your_bot_token_here') {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set — bot disabled');
      return;
    }
    this.bot = new Bot(token);
    this.register();
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Start' },
      { command: 'me', description: 'Profile' },
      { command: 'language', description: 'Language' },
      { command: 'where', description: 'Street or district (Desktop)' },
      { command: 'addchannel', description: 'Admin: add channel' },
      { command: 'place', description: 'Admin: explain place (geocodes if new)' },
      { command: 'places', description: 'Admin: unexplained toponyms' },
    ]);
    void this.bot.start({
      onStart: () => this.logger.log('Telegram bot started'),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  async sendHtml(chatId: number, html: string): Promise<boolean> {
    if (!this.bot) return false;
    await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
    return true;
  }

  private register(): void {
    const bot = this.bot!;

    bot.use(async (ctx, next) => {
      if (!ctx.from) return next();
      const user = await this.prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
      if (user?.isBanned) {
        await ctx.reply(t(user.locale, 'ban_denied'));
        return;
      }
      return next();
    });

    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('me', (ctx) => this.onProfile(ctx));
    bot.command('settings', (ctx) => this.onSettings(ctx));
    bot.command('language', (ctx) => this.onLanguage(ctx));
    bot.command('where', (ctx) => this.onWhereCmd(ctx));
    bot.command('addchannel', (ctx) => this.onAddChannelCmd(ctx));
    bot.command('place', (ctx) => this.onPlaceCmd(ctx));
    bot.command('places', (ctx) => this.onPlacesCmd(ctx));
    bot.command('admin', (ctx) => this.onAdmin(ctx));

    bot.hears([t('ua', 'menu_area'), t('ru', 'menu_area'), t('en', 'menu_area')], (ctx) => this.askArea(ctx));
    bot.hears([t('ua', 'menu_profile'), t('ru', 'menu_profile'), t('en', 'menu_profile')], (ctx) => this.onProfile(ctx));
    bot.hears([t('ua', 'menu_settings'), t('ru', 'menu_settings'), t('en', 'menu_settings')], (ctx) => this.onSettings(ctx));
    bot.hears([t('ua', 'menu_admin'), t('ru', 'menu_admin'), t('en', 'menu_admin')], (ctx) => this.onAdmin(ctx));

    bot.on(['message:location', 'message:venue', 'edited_message:location'], (ctx) => this.onLocation(ctx));
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  private mainMenu(locale: string, isAdmin: boolean): Keyboard {
    const kb = new Keyboard()
      .requestLocation(t(locale, 'menu_location'))
      .text(t(locale, 'menu_area'))
      .row()
      .text(t(locale, 'menu_profile'))
      .text(t(locale, 'menu_settings'));
    if (isAdmin) kb.row().text(t(locale, 'menu_admin'));
    return kb.resized().persistent();
  }

  private languageKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('🇺🇦 Українська', 'set_lang_ua')
      .text('🇷🇺 Русский', 'set_lang_ru')
      .text('🇬🇧 English', 'set_lang_en');
  }

  private async upsertUser(ctx: Context) {
    const from = ctx.from!;
    const locale: Locale = from.language_code === 'uk' ? 'ua' : from.language_code === 'ru' ? 'ru' : 'en';
    const isAdmin = this.adminIds.has(String(from.id));
    return this.prisma.user.upsert({
      where: { telegramId: BigInt(from.id) },
      update: {
        username: from.username ?? null,
        firstName: from.first_name,
        lastName: from.last_name ?? null,
        isAdmin: isAdmin || undefined,
      },
      create: {
        telegramId: BigInt(from.id),
        username: from.username ?? null,
        firstName: from.first_name,
        lastName: from.last_name ?? null,
        isAdmin,
        locale,
      },
    });
  }

  private async onStart(ctx: Context): Promise<void> {
    const user = await this.upsertUser(ctx);
    this.logger.log(`/start user=${user.telegramId} admin=${user.isAdmin} geo=${user.lat != null}`);
    await ctx.reply(t(user.locale, 'welcome', { name: user.firstName || 'User' }), {
      reply_markup: this.mainMenu(user.locale, user.isAdmin),
    });
    if (user.lat == null) {
      await ctx.reply(t(user.locale, 'need_location'));
    }
    const extras = channelInviteHints(this.config);
    if (extras.length) {
      await ctx.reply(`${t(user.locale, 'invite_other_channels')}\n${extras.join('\n')}`);
    }
  }

  private async onLocation(ctx: Context): Promise<void> {
    const loc = ctx.msg?.location ?? ctx.msg?.venue?.location;
    if (!loc || !ctx.from) return;
    const user = await this.upsertUser(ctx);
    const area = this.geo.resolveUserArea(loc.latitude, loc.longitude);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lat: loc.latitude,
        lon: loc.longitude,
        oblastCode: area.oblastCode,
        locationUpdatedAt: new Date(),
      },
    });
    this.logger.log(
      `location user=${updated.telegramId} ${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)} area=${area.label} (${area.oblastCode})`,
    );
    if (ctx.editedMessage) return;
    const key = area.oblastCode === 'outside' ? 'location_saved_no_oblast' : 'location_saved';
    await ctx.reply(t(updated.locale, key, { oblast: area.label }), {
      reply_markup: this.mainMenu(updated.locale, updated.isAdmin),
    });
  }

  private async onProfile(ctx: Context): Promise<void> {
    const user = await this.upsertUser(ctx);
    const geo =
      user.lat != null && user.lon != null
        ? `${user.lat.toFixed(4)}, ${user.lon.toFixed(4)}`
        : t(user.locale, 'profile_no_geo');
    const text = [
      t(user.locale, 'profile_title'),
      '',
      t(user.locale, 'profile_id', { id: user.telegramId?.toString() ?? String(user.id) }),
      t(user.locale, 'profile_admin', { status: t(user.locale, user.isAdmin ? 'yes' : 'no') }),
      t(user.locale, 'profile_silent', { status: t(user.locale, user.silentMode ? 'on' : 'off') }),
      t(user.locale, 'profile_geo', { geo }),
      t(user.locale, 'profile_oblast', { oblast: this.geo.labelForCode(user.oblastCode) }),
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: this.mainMenu(user.locale, user.isAdmin) });
  }

  private async onSettings(ctx: Context): Promise<void> {
    const user = await this.upsertUser(ctx);
    const status = t(user.locale, user.silentMode ? 'on' : 'off');
    const btn = t(user.locale, user.silentMode ? 'settings_toggle_silent_off' : 'settings_toggle_silent_on');
    const keyboard = new InlineKeyboard().text(btn, 'toggle_silent').row().text('🌐 Language', 'change_lang');
    const extras = channelInviteHints(this.config);
    const channels = extras.length ? `\n\n${t(user.locale, 'invite_other_channels')}\n${extras.join('\n')}` : '';
    await ctx.reply(
      `${t(user.locale, 'settings_title')}\n\n${t(user.locale, 'settings_silent_mode', { status })}${channels}`,
      { reply_markup: keyboard },
    );
  }

  private async onLanguage(ctx: Context): Promise<void> {
    const user = await this.upsertUser(ctx);
    await ctx.reply(t(user.locale, 'lang_select'), { reply_markup: this.languageKeyboard() });
  }

  private async requireAdmin(ctx: Context) {
    const user = await this.upsertUser(ctx);
    if (!user.isAdmin) {
      await ctx.reply(t(user.locale, 'admin_denied'));
      return null;
    }
    return user;
  }

  private async onAdmin(ctx: Context): Promise<void> {
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    const channels = await this.prisma.channel.findMany();
    const list = channels.map((c) => `• @${c.link}`).join('\n') || '—';
    const keyboard = new InlineKeyboard()
      .text(t(user.locale, 'admin_add_channel'), 'admin_add_channel')
      .row()
      .text(t(user.locale, 'admin_add_place'), 'admin_add_place')
      .row()
      .text(t(user.locale, 'admin_list_places'), 'admin_list_places');
    await ctx.reply(
      `${t(user.locale, 'admin_title')}\n\n${t(user.locale, 'admin_manage_rules')}\n\n${list}\n\n${t(user.locale, 'admin_direct_cmds')}`,
      { parse_mode: 'Markdown', reply_markup: keyboard },
    );
  }

  private async onAddChannelCmd(ctx: Context): Promise<void> {
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    const name = ctx.message?.text?.split(/\s+/)[1]?.replace(/^@/, '');
    if (!name) {
      this.wait.set(ctx.from!.id, 'channel');
      await ctx.reply(t(user.locale, 'admin_ask_channel'));
      return;
    }
    await this.addChannel(ctx, user.locale, name);
  }

  private async onPlaceCmd(ctx: Context): Promise<void> {
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    const rest = ctx.message?.text?.replace(/^\/place(@\w+)?\s*/i, '').trim() ?? '';
    if (!rest) {
      this.placeDraft.delete(ctx.from!.id);
      this.wait.set(ctx.from!.id, 'place');
      await ctx.reply(t(user.locale, 'admin_ask_place'));
      return;
    }
    await this.savePlaceAlias(ctx, user.locale, rest);
  }

  private async onPlacesCmd(ctx: Context): Promise<void> {
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    const rest = ctx.message?.text?.replace(/^\/places(@\w+)?\s*/i, '').trim() ?? '';
    if (rest.toLowerCase().startsWith('drop ')) {
      const ok = await this.toponyms.dismissUnknown(rest.slice(5).trim());
      await ctx.reply(t(user.locale, ok ? 'admin_place_dropped' : 'admin_place_drop_miss'));
      return;
    }
    await this.replyUnknownList(ctx, user.locale);
  }

  private async replyUnknownList(ctx: Context, locale: string): Promise<void> {
    const rows = await this.toponyms.listUnknown();
    if (!rows.length) {
      await ctx.reply(t(locale, 'unknown_place_empty'));
      return;
    }
    const lines = [
      t(locale, 'unknown_place_list', { n: String(rows.length) }),
      '',
      ...rows.map(
        (row, i) =>
          `${i + 1}. ${row.label} ×${row.hitCount}` +
          (row.channel ? ` @${row.channel}` : '') +
          (row.sampleText ? `\n   ${previewMessage(row.sampleText, 80)}` : ''),
      ),
      '',
      t(locale, 'unknown_place_how', { alias: rows[0]?.label ?? 'СС' }),
    ];
    const keyboard = new InlineKeyboard();
    for (const row of rows.slice(0, 8)) {
      keyboard.text(row.label.slice(0, 28), `teach:${row.id}`).text('✕', `forget:${row.id}`).row();
    }
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  }

  async askUnknownToponym(input: {
    channel: string;
    text: string;
    guesses: string[];
  }): Promise<void> {
    const stored = await this.toponyms.rememberUnknown({
      labels: input.guesses,
      sampleText: input.text,
      channel: input.channel,
    });
    if (!stored.created.length) return;

    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true, isBanned: false, telegramId: { not: null } },
    });
    const guesses = stored.created.map((row) => row.label).join(', ');
    const teachId = stored.created[0]?.id;
    const example = stored.created[0]?.label ?? guesses.split(', ')[0] ?? 'СС';
    for (const admin of admins) {
      if (admin.telegramId == null) continue;
      const loc = admin.locale;
      const body = [
        `<b>${escapeHtml(t(loc, 'unknown_place_title'))}</b>`,
        `@${escapeHtml(input.channel)}: ${escapeHtml(previewMessage(input.text, 220))}`,
        escapeHtml(t(loc, 'unknown_place_guess', { places: guesses })),
        '',
        escapeHtml(t(loc, 'unknown_place_how', { alias: example })),
        `<code>${escapeHtml(`${example} = `)}</code>`,
        escapeHtml(t(loc, 'unknown_place_saved')),
      ].join('\n');
      const keyboard = new InlineKeyboard()
        .text(t(loc, 'admin_add_place'), teachId != null ? `teach:${teachId}` : 'admin_add_place')
        .text(t(loc, 'admin_list_places'), 'admin_list_places');
      try {
        if (!this.bot) return;
        await this.bot.api.sendMessage(Number(admin.telegramId), body, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        this.logger.warn(`unknown-place notify admin ${admin.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async savePlaceAlias(ctx: Context, locale: string, raw: string): Promise<void> {
    const fromId = ctx.from?.id;
    const draft = fromId != null ? this.placeDraft.get(fromId) : undefined;
    if (fromId != null) this.placeDraft.delete(fromId);
    const parsed = parsePlaceAlias(raw) ?? (draft && raw.trim().length >= 2
      ? { alias: draft, meaning: raw.trim() }
      : raw.trim().length >= 2 && !raw.includes('=')
        ? { alias: raw.trim(), meaning: raw.trim() }
        : null);
    if (!parsed) {
      await ctx.reply(t(locale, 'admin_ask_place'));
      return;
    }
    const result = await this.toponyms.explain(parsed.alias, parsed.meaning);
    if (!result.ok && result.reason === 'foreign') {
      await ctx.reply(t(locale, 'admin_place_foreign', { name: parsed.meaning }));
      return;
    }
    if (!result.ok && result.reason === 'unknown_target') {
      if (fromId != null) {
        this.placeDraft.set(fromId, parsed.alias);
        this.wait.set(fromId, 'place');
      }
      await ctx.reply(t(locale, 'admin_place_unknown_target', { name: parsed.meaning }));
      return;
    }
    if (!result.ok) {
      await ctx.reply(t(locale, 'admin_ask_place'));
      return;
    }
    await ctx.reply(
      t(locale, 'admin_place_geocoded', {
        place: result.place,
        lat: result.lat.toFixed(3),
        lon: result.lon.toFixed(3),
      }),
    );
  }

  private async addChannel(ctx: Context, locale: string, raw: string): Promise<void> {
    const name = raw.replace(/^@/, '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,64}$/i.test(name)) {
      await ctx.reply(t(locale, 'admin_ask_channel'));
      return;
    }
    const existing = await this.prisma.channel.findUnique({ where: { link: name } });
    if (existing) {
      await ctx.reply(t(locale, 'admin_channel_exists', { name }));
      return;
    }
    await this.prisma.channel.create({ data: { link: name, name, scrapTimeout: 3000 } });
    this.logger.log(`channel added @${name}`);
    await ctx.reply(t(locale, 'admin_channel_added', { name }));
  }

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data || !ctx.from) return;
    const user = await this.upsertUser(ctx);

    if (data === 'change_lang') {
      await ctx.editMessageText(t(user.locale, 'lang_select'), { reply_markup: this.languageKeyboard() });
      await ctx.answerCallbackQuery();
      return;
    }
    if (data.startsWith('set_lang_')) {
      const locale = data.replace('set_lang_', '');
      await this.prisma.user.update({ where: { id: user.id }, data: { locale } });
      await ctx.answerCallbackQuery(t(locale, 'lang_changed'));
      await ctx.reply(t(locale, 'welcome', { name: user.firstName || 'User' }), {
        reply_markup: this.mainMenu(locale, user.isAdmin),
      });
      return;
    }
    if (data.startsWith('area:')) {
      this.wait.delete(ctx.from.id);
      await ctx.answerCallbackQuery();
      await this.saveArea(ctx, data.slice(5));
      return;
    }
    if (data === 'toggle_silent') {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { silentMode: !user.silentMode },
      });
      await ctx.answerCallbackQuery(t(updated.locale, updated.silentMode ? 'on' : 'off'));
      return;
    }
    if (!user.isAdmin) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (data === 'admin_add_channel') {
      this.wait.set(ctx.from.id, 'channel');
      await ctx.reply(t(user.locale, 'admin_ask_channel'));
    }
    if (data === 'admin_add_place') {
      this.placeDraft.delete(ctx.from.id);
      this.wait.set(ctx.from.id, 'place');
      await ctx.reply(t(user.locale, 'admin_ask_place'));
    }
    if (data === 'admin_list_places') {
      await this.replyUnknownList(ctx, user.locale);
    }
    if (data.startsWith('teach:')) {
      const id = Number(data.slice(6));
      const row = Number.isInteger(id) ? await this.prisma.unknownToponym.findUnique({ where: { id } }) : null;
      this.wait.set(ctx.from.id, 'place');
      if (row) this.placeDraft.set(ctx.from.id, row.label);
      else this.placeDraft.delete(ctx.from.id);
      await ctx.reply(row ? t(user.locale, 'admin_ask_place_for', { alias: row.label }) : t(user.locale, 'admin_ask_place'));
    }
    if (data.startsWith('forget:')) {
      const ok = await this.toponyms.dismissUnknown(data.slice(7));
      await ctx.answerCallbackQuery(ok ? t(user.locale, 'admin_place_dropped') : '—');
      await this.replyUnknownList(ctx, user.locale);
      return;
    }
    await ctx.answerCallbackQuery();
  }

  private async onText(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.message || !('text' in ctx.message) || !ctx.message.text) return;
    if (ctx.message.text.startsWith('/')) return;
    const pending = this.wait.get(ctx.from.id);
    if (!pending) return;
    this.wait.delete(ctx.from.id);
    if (pending === 'area') {
      await this.saveArea(ctx, ctx.message.text);
      return;
    }
    const user = await this.requireAdmin(ctx);
    if (!user) return;
    if (pending === 'place') {
      await this.savePlaceAlias(ctx, user.locale, ctx.message.text);
      return;
    }
    await this.addChannel(ctx, user.locale, ctx.message.text);
  }

  private async onWhereCmd(ctx: Context): Promise<void> {
    const name = ctx.message?.text?.replace(/^\/where(@\w+)?\s*/i, '').trim();
    if (!name) {
      await this.askArea(ctx);
      return;
    }
    await this.saveArea(ctx, name);
  }

  private async askArea(ctx: Context): Promise<void> {
    const user = await this.upsertUser(ctx);
    this.wait.set(ctx.from!.id, 'area');
    const keyboard = new InlineKeyboard()
      .text('Центр', 'area:центр')
      .text('Наукова', 'area:наукова')
      .row()
      .text('Отаманівського', 'area:отаманівського')
      .text('Павлове Поле', 'area:павлове поле')
      .row()
      .text('Салтівка', 'area:салтівка')
      .text('Олексіївка', 'area:олексіївка');
    await ctx.reply(t(user.locale, 'ask_area'), { reply_markup: keyboard });
  }

  private async saveArea(ctx: Context, raw: string): Promise<void> {
    const user = await this.upsertUser(ctx);
    const place = this.geo.findPlace(raw);
    if (!place) {
      await ctx.reply(t(user.locale, 'area_unknown', { name: raw.trim() }));
      return;
    }
    const area = this.geo.resolveUserArea(place.lat, place.lon);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lat: place.lat,
        lon: place.lon,
        oblastCode: area.oblastCode,
        locationUpdatedAt: new Date(),
      },
    });
    this.logger.log(`area user=${user.telegramId} "${raw}" -> ${place.name} ${place.lat},${place.lon}`);
    await ctx.reply(t(user.locale, 'location_saved', { oblast: place.name }), {
      reply_markup: this.mainMenu(user.locale, user.isAdmin),
    });
  }
}
