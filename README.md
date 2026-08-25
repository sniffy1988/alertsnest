# alertsNest

Telegram-бот: параллельно читает публичные каналы (`t.me/s/...`), пачкой отдаёт посты в локальную модель и предупреждает, если угроза рядом с геопозицией пользователя.

Публичный образ (linux/amd64 + linux/arm64, Apple Silicon и Intel):

```text
ghcr.io/sniffy1988/alertsnest:latest
```

## Docker на другом Mac

Нужны Docker Desktop и файл `.env` (токен бота). Модель подтянется в контейнер Ollama при первом старте.

```bash
mkdir alertsnest && cd alertsnest
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sniffy1988/alertsnest/main/docker-compose.yml
curl -fsSL -o .env.example \
  https://raw.githubusercontent.com/sniffy1988/alertsnest/main/.env.example
cp .env.example .env
# заполни TELEGRAM_BOT_TOKEN (и при желании TELEGRAM_ADMIN_IDS)

docker compose pull
docker compose up -d
```

Health: `http://127.0.0.1:8080/health`

SQLite лежит в volume `alerts-data`, веса Ollama — в `ollama-data`. Если кастомной `qwen2.5-3b-m2:latest` нет в реестре Ollama, задай публичную модель в `.env`:

```bash
OLLAMA_MODEL=qwen2.5:3b
```

и перезапусти `docker compose up -d`.

Собрать локально без образа из GHCR:

```bash
docker compose up -d --build
```

Ollama на хосте вместо контейнера — в `docker-compose.yml` у сервиса `app` поставь `OLLAMA_HOST=http://host.docker.internal:11434` и закомментируй `depends_on` / сервисы `ollama` и `ollama-pull`.

## Локальный запуск без Docker

- Node.js 20+
- [Ollama](https://ollama.com) с моделью из `OLLAMA_MODEL` (`ollama list`)
- Telegram-бот (`TELEGRAM_BOT_TOKEN`)

```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

Интервал скрапа по умолчанию — **3 секунды**. Пачка в модель: 6 сообщений или 2 секунды ожидания.

## Бот

1. `/start` — регистрация
2. Кнопка геолокации — точка в Харькове
3. Админ задаёт каналы: `/addchannel username`

Алерт, если угроза в вашем районе/на улице или по всему городу. Решение «это угроза?» только у модели.
