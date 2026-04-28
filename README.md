# 🤖 Семейный бот учёта расходов

Telegram-бот который распознаёт чеки и сохраняет данные в Google Sheets.

## Переменные окружения (Environment Variables)

Нужно задать в Railway перед деплоем:

| Переменная | Что это |
|---|---|
| `TELEGRAM_TOKEN` | Токен от @BotFather |
| `SPREADSHEET_ID` | ID вашей Google таблицы |
| `ANTHROPIC_API_KEY` | Ключ Claude API |
| `GOOGLE_CREDENTIALS` | Содержимое JSON файла сервисного аккаунта (одной строкой) |

## Деплой на Railway

1. Загрузи код на GitHub
2. Зайди на railway.app
3. New Project → Deploy from GitHub
4. Добавь все переменные окружения
5. Готово!

## Команды бота

- `/start` — приветствие
- `/отчет` — статистика за месяц
- `/помощь` — инструкция
- Отправить фото чека — распознавание и сохранение
