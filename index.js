const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// ─── НАСТРОЙКИ ───────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
// ─────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const CATEGORIES = {
  'Фрукты и овощи': ['яблок','банан','морков','огурц','помидор','картош','лук','чеснок','капуст','зелен','лимон','апельсин','арбуз','киви','свекл','перец','кабачк','брокол','кукуруз','гриб','мята'],
  'Мясо и рыба': ['курин','фарш','мясо','говяд','свинин','тунец','рыб','сосиск','колбас','креветк','морепродукт','филе','бедр','крабов'],
  'Молочное и яйца': ['молок','яйц','сметан','творог','йогурт','сыр','масло слив','кефир','сливк','ряженк'],
  'Крупы и макароны': ['греч','рис','овсян','макарон','спагетт','лапш','перловк','мука','хлопь'],
  'Хлеб и выпечка': ['хлеб','батон','булк','хлебц','галет','коржи','выпечк','тарталет'],
  'Напитки': ['чай','кофе','сок','вод','cola','кола','напиток','морс'],
  'Соусы и специи': ['масло','соус','кетчуп','майонез','соль','сахар','уксус','специ','хмели','зира','ванилин','имбир','кунжут'],
  'Сладкое': ['шоколад','печень','конфет','джем','сгущ','варень','торт','пирож','арахис'],
  'Бытовая химия': ['порошок','средство','мешк','пакет','губк','тряпк','белизн','синергет','силит','proper','крот'],
  'Гигиена': ['шампунь','зубн','мыло','ватн','салфетк','бумаг','душ','дезодор','краска для волос'],
};

function guessCategory(itemName) {
  const lower = itemName.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  return 'Прочее';
}

async function initSpreadsheet() {
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existingSheets = res.data.sheets.map(s => s.properties.title);
    const toCreate = ['Чеки','Товары'].filter(n => !existingSheets.includes(n));

    if (toCreate.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: toCreate.map(title => ({ addSheet: { properties: { title } } })) }
      });
    }

    if (!existingSheets.includes('Чеки')) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: 'Чеки!A1:F1', valueInputOption: 'RAW',
        requestBody: { values: [['Дата','Время','Магазин','Кто загрузил','Итого (₽)','Статус']] }
      });
    }
    if (!existingSheets.includes('Товары')) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: 'Товары!A1:G1', valueInputOption: 'RAW',
        requestBody: { values: [['Дата','Магазин','Товар','Количество','Цена (₽)','Категория','Кто']] }
      });
    }
    console.log('✅ Таблица готова');
  } catch (e) {
    console.error('Ошибка инициализации:', e.message);
  }
}

async function analyzeReceipt(imageBuffer) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const imagePart = { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/jpeg' } };
  const prompt = `Это фото кассового чека. Верни ТОЛЬКО JSON без markdown и пояснений:
{"store":"название магазина или Неизвестно","total":сумма_числом,"items":[{"name":"товар","qty":количество,"price":цена}]}
Если не чек: {"error":"Это не чек"}`;

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function analyzeSpending(byCategory, total, monthName) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const prompt = `Ты финансовый помощник семьи. Расходы за ${monthName}:
${Object.entries(byCategory).map(([k,v]) => `${k}: ${Math.round(v)}₽`).join('\n')}
Итого: ${Math.round(total)}₽

Дай краткий дружелюбный анализ на русском: на что больше всего, что можно оптимизировать, один совет. Используй эмодзи. Максимум 5 предложений.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function saveToSheets(receipt, userName) {
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU');
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Чеки!A:F', valueInputOption: 'RAW',
    requestBody: { values: [[date, time, receipt.store, userName, receipt.total, '✅']] }
  });

  if (receipt.items && receipt.items.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Товары!A:G', valueInputOption: 'RAW',
      requestBody: { values: receipt.items.map(item => [date, receipt.store, item.name, item.qty||1, item.price||'', guessCategory(item.name), userName]) }
    });
  }
}

async function getMonthStats() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Товары!A:G' });
  const rows = (res.data.values || []).slice(1);
  if (!rows.length) return null;

  const now = new Date();
  const thisMonth = now.toLocaleDateString('ru-RU').slice(3);
  const monthRows = rows.filter(r => r[0] && r[0].slice(3) === thisMonth);
  if (!monthRows.length) return null;

  const byCategory = {};
  let total = 0;
  monthRows.forEach(r => {
    const sum = (parseFloat(r[4])||0) * (parseFloat(r[3])||1);
    const cat = r[5] || 'Прочее';
    byCategory[cat] = (byCategory[cat]||0) + sum;
    total += sum;
  });

  const sorted = Object.entries(byCategory).sort((a,b) => b[1]-a[1]);
  const monthName = now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  let text = `📊 *Расходы за ${monthName}*\n\n`;
  sorted.forEach(([cat, sum]) => {
    const pct = Math.round(sum/total*100);
    const bar = '▓'.repeat(Math.round(pct/10)) + '░'.repeat(10-Math.round(pct/10));
    text += `*${cat}*\n${bar} ${Math.round(sum)}₽ (${pct}%)\n\n`;
  });
  text += `💰 *Итого: ${Math.round(total)}₽*`;

  try {
    const analysis = await analyzeSpending(byCategory, total, monthName);
    text += `\n\n🤖 *Анализ:*\n${analysis}`;
  } catch(e) { console.error('Ошибка анализа:', e.message); }

  return text;
}

// ─── КОМАНДЫ ─────────────────────────────────────────────────

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    `👋 Привет, ${msg.from.first_name}!\n\nЯ веду учёт расходов вашей семьи.\n\n📸 Отправь фото чека — я распознаю и сохраню всё сам.\n\n/отчет — расходы за месяц\n/помощь — инструкция`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/помощь/, msg => {
  bot.sendMessage(msg.chat.id,
    `🤖 *Как пользоваться:*\n\n1. Сфотографируй чек\n2. Отправь фото боту\n3. Бот сохранит в Google таблицу\n4. /отчет — статистика и анализ за месяц`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/отчет/, async msg => {
  const m = await bot.sendMessage(msg.chat.id, '⏳ Считаю расходы...');
  try {
    const stats = await getMonthStats();
    await bot.deleteMessage(msg.chat.id, m.message_id);
    bot.sendMessage(msg.chat.id, stats || '📭 Чеков за этот месяц пока нет!', { parse_mode: 'Markdown' });
  } catch(e) {
    console.error(e.message);
    bot.sendMessage(msg.chat.id, '❌ Ошибка при получении статистики');
  }
});

bot.on('photo', async msg => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Неизвестно';
  const m = await bot.sendMessage(chatId, '🔍 Распознаю чек...');

  try {
    const fileInfo = await bot.getFile(msg.photo[msg.photo.length-1].file_id);
    const imgRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`, { responseType: 'arraybuffer' });
    const receipt = await analyzeReceipt(Buffer.from(imgRes.data));

    await bot.deleteMessage(chatId, m.message_id);

    if (receipt.error) {
      bot.sendMessage(chatId, `❌ ${receipt.error}\n\nОтправь чёткое фото кассового чека.`);
      return;
    }

    await saveToSheets(receipt, userName);

    let reply = `✅ *Чек сохранён!*\n\n🏪 ${receipt.store}\n💰 *${receipt.total}₽* — ${receipt.items.length} позиций`;
    if (receipt.items.length <= 8) {
      reply += '\n\n' + receipt.items.map(i => `• ${i.name} — ${i.price}₽`).join('\n');
    }
    reply += '\n\n📊 Записано в таблицу!';

    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch(e) {
    console.error('Ошибка чека:', e.message);
    await bot.deleteMessage(chatId, m.message_id).catch(()=>{});
    bot.sendMessage(chatId, '❌ Не удалось распознать чек. Попробуй сфотографировать чётче.');
  }
});

initSpreadsheet().then(() => console.log('🤖 Бот запущен!'));
