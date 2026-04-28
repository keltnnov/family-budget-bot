const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');

// ─── НАСТРОЙКИ ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
// ─────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Google Sheets авторизация
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Категории товаров
const CATEGORIES = {
  'Фрукты и овощи': ['яблок', 'банан', 'морков', 'огурц', 'помидор', 'картош', 'лук', 'чеснок', 'капуст', 'зелен', 'лимон', 'апельсин', 'арбуз', 'киви', 'свекл', 'перец', 'кабачк', 'брокол', 'кукуруз', 'гриб'],
  'Мясо и рыба': ['курин', 'фарш', 'мясо', 'говяд', 'свинин', 'тунец', 'рыб', 'сосиск', 'колбас', 'креветк', 'морепродукт', 'филе', 'бедр'],
  'Молочное и яйца': ['молок', 'яйц', 'сметан', 'творог', 'йогурт', 'сыр', 'масло слив', 'кефир', 'сливк', 'ряженк'],
  'Крупы и макароны': ['греч', 'рис', 'овсян', 'макарон', 'спагетт', 'лапш', 'перловк', 'мука', 'хлопь'],
  'Хлеб и выпечка': ['хлеб', 'батон', 'булк', 'хлебц', 'галет', 'коржи', 'выпечк'],
  'Напитки': ['чай', 'кофе', 'сок', 'вод', 'cola', 'кола', 'напиток', 'морс'],
  'Соусы и специи': ['масло', 'соус', 'кетчуп', 'майонез', 'соль', 'сахар', 'уксус', 'специ', 'перец молот', 'хмели'],
  'Сладкое': ['шоколад', 'печень', 'конфет', 'джем', 'сгущ', 'варень', 'торт', 'пирож'],
  'Бытовая химия': ['порошок', 'гель', 'средство', 'мешк', 'пакет', 'губк', 'тряпк', 'белизн', 'синергет', 'силит', 'mr. proper', 'крот'],
  'Гигиена': ['шампунь', 'зубн', 'мыло', 'ватн', 'салфетк', 'бумаг', 'гель для душ', 'дезодор', 'перчатк'],
};

function guessCategory(itemName) {
  const lower = itemName.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  return 'Прочее';
}

// Инициализация листов в таблице
async function initSpreadsheet() {
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existingSheets = res.data.sheets.map(s => s.properties.title);

    const needed = ['Чеки', 'Товары'];
    const toCreate = needed.filter(n => !existingSheets.includes(n));

    if (toCreate.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: toCreate.map(title => ({
            addSheet: { properties: { title } }
          }))
        }
      });
    }

    // Заголовки для листа Чеки
    if (!existingSheets.includes('Чеки')) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Чеки!A1:F1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Дата', 'Время', 'Магазин', 'Кто загрузил', 'Итого (₽)', 'Статус']] }
      });
    }

    // Заголовки для листа Товары
    if (!existingSheets.includes('Товары')) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Товары!A1:G1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Дата', 'Магазин', 'Товар', 'Количество', 'Цена (₽)', 'Категория', 'Кто']] }
      });
    }

    console.log('Таблица инициализирована');
  } catch (e) {
    console.error('Ошибка инициализации таблицы:', e.message);
  }
}

// Распознавание чека через Claude
async function analyzeReceipt(imageBase64) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
          },
          {
            type: 'text',
            text: `Это фото кассового чека из магазина. Распознай его и верни ТОЛЬКО JSON без пояснений:
{
  "store": "название магазина или Неизвестно",
  "total": число (итоговая сумма в рублях, или 0 если не видно),
  "items": [
    { "name": "название товара", "qty": количество, "price": цена_за_штуку }
  ]
}
Если это не чек — верни { "error": "Это не чек" }`
          }
        ]
      }]
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );

  const text = response.data.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Сохранение чека в Google Sheets
async function saveToSheets(receipt, userName) {
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU');
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // Лист Чеки
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Чеки!A:F',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[date, time, receipt.store, userName, receipt.total, '✅ Загружен']]
    }
  });

  // Лист Товары
  if (receipt.items && receipt.items.length > 0) {
    const rows = receipt.items.map(item => [
      date,
      receipt.store,
      item.name,
      item.qty || 1,
      item.price || '',
      guessCategory(item.name),
      userName
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Товары!A:G',
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }
}

// Получение статистики за месяц
async function getMonthStats() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Товары!A:G',
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return null;

  const now = new Date();
  const thisMonth = now.toLocaleDateString('ru-RU').slice(3); // MM.YYYY

  const monthRows = rows.slice(1).filter(r => r[0] && r[0].slice(3) === thisMonth);
  if (monthRows.length === 0) return null;

  const byCategory = {};
  let total = 0;

  monthRows.forEach(r => {
    const price = parseFloat(r[4]) || 0;
    const qty = parseFloat(r[3]) || 1;
    const sum = price * qty;
    const cat = r[5] || 'Прочее';
    byCategory[cat] = (byCategory[cat] || 0) + sum;
    total += sum;
  });

  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  let text = `📊 *Расходы за ${now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}*\n\n`;
  sorted.forEach(([cat, sum]) => {
    const pct = Math.round(sum / total * 100);
    const bar = '▓'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    text += `${cat}\n${bar} ${Math.round(sum)}₽ (${pct}%)\n\n`;
  });
  text += `💰 *Итого: ${Math.round(total)}₽*`;

  return text;
}

// ─── ОБРАБОТЧИКИ КОМАНД ──────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Привет, ${msg.from.first_name}!\n\nЯ семейный бот для учёта расходов.\n\n` +
    `📸 Просто отправь мне *фото чека* — я распознаю и сохраню всё автоматически.\n\n` +
    `Команды:\n` +
    `/отчет — расходы за этот месяц\n` +
    `/помощь — как пользоваться`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/помощь/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🤖 *Как пользоваться ботом:*\n\n` +
    `1. Сфотографируй чек после покупки\n` +
    `2. Отправь фото прямо сюда\n` +
    `3. Бот распознает товары и сохранит в таблицу\n` +
    `4. Команда /отчет покажет статистику за месяц\n\n` +
    `📊 Все данные хранятся в вашей Google таблице — можно смотреть в любой момент!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/отчет/, async (msg) => {
  const thinking = await bot.sendMessage(msg.chat.id, '⏳ Считаю расходы...');
  try {
    const stats = await getMonthStats();
    await bot.deleteMessage(msg.chat.id, thinking.message_id);
    if (!stats) {
      bot.sendMessage(msg.chat.id, '📭 За этот месяц чеков пока нет. Отправь фото чека!');
    } else {
      bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

// Обработка фото чека
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Неизвестно';

  const thinking = await bot.sendMessage(chatId, '🔍 Распознаю чек...');

  try {
    // Берём фото в максимальном качестве
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    const fileInfo = await bot.getFile(photoId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

    // Скачиваем фото
    const imgRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(imgRes.data).toString('base64');

    // Распознаём через Claude
    const receipt = await analyzeReceipt(base64);

    if (receipt.error) {
      await bot.deleteMessage(chatId, thinking.message_id);
      bot.sendMessage(chatId, `❌ ${receipt.error}\n\nОтправь чёткое фото кассового чека.`);
      return;
    }

    // Сохраняем в таблицу
    await saveToSheets(receipt, userName);
    await bot.deleteMessage(chatId, thinking.message_id);

    // Формируем ответ
    let reply = `✅ *Чек сохранён!*\n\n`;
    reply += `🏪 Магазин: ${receipt.store}\n`;
    reply += `💰 Итого: *${receipt.total}₽*\n\n`;
    reply += `📦 Товаров: ${receipt.items.length} позиций\n`;

    if (receipt.items.length > 0 && receipt.items.length <= 8) {
      reply += '\n';
      receipt.items.forEach(item => {
        reply += `• ${item.name} — ${item.price}₽\n`;
      });
    }

    reply += `\n📊 Всё записано в таблицу!`;

    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error('Ошибка обработки чека:', e.message);
    await bot.deleteMessage(chatId, thinking.message_id);
    bot.sendMessage(chatId, '❌ Не удалось распознать чек. Попробуй сфотографировать чётче.');
  }
});

// Запуск
initSpreadsheet().then(() => {
  console.log('🤖 Бот запущен!');
});
