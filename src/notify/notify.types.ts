export type DeliveryUser = {
  id: number;
  telegramId: bigint | null;
  whatsappPhone: string | null;
  viberId: string | null;
  locale: string;
};

export type AlertMessage = {
  html: string;
  text: string;
  telegramMarkup?: import('grammy').InlineKeyboard;
};
