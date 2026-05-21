const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const https = require('https');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SHEET_ID = '1KNvzA-BVY1i930m6KtiElPeFqiMeUtGB_YuQcOfo7_I';

const COMPANY_SHEETS = [
  'ENVIGO TRANSPORTATION LLC', 'D LOGISTICS LLC', 'MUSATTO CARGO INC',
  'ATN UNITED INC', 'GOLDEN HORSE TRANSPORT LLC', 'GMG EXPRESS LLC',
  'CROSS COUNTRY FREIGHT LINES', 'ALTIM TRANS LLC', 'LARCIN EXPRESS LLC',
  'SAFEROAD LLC', 'CHAGOON LOGISTICS LLC', 'JASNX INC',
  'NEWPORT EXPRESS LLC', 'OINA BUSINESS LLC', 'REX UZ INC',
  'BURNING GUN LLC', 'LOCHIN EXPRESS LLC',
];

const EXP_COLS = ['CDL EXP', 'MED CARD', 'CH EXP', 'MVR EXP', 'ANNUAL INSP', 'CAB CARD'];

// In-memory storage
let records = [];
let lastSync = null;

const bot = new TelegramBot(TOKEN, { polling: true });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  if (!str || ['not yet', 'n/a', 'owner', '-', ''].includes(str.toLowerCase())) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function daysUntil(dateStr) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function emoji(days) {
  if (days < 0) return '🔴';
  if (days <= 7) return '🔴';
  if (days <= 14) return '🟠';
  if (days <= 30) return '🟡';
  return '🟢';
}

async function syncSheet() {
  const newRecords = [];
  const errors = [];

  for (const company of COMPANY_SHEETS) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(company)}&t=${Date.now()}`;
      const csv = await fetchUrl(url);
      const rows = csv.split('\n').filter(l => l.trim()).map(parseCSVLine);

      let headerIdx = -1, colMap = {};
      for (let i = 0; i < rows.length; i++) {
        const up = rows[i].map(c => c.toUpperCase().trim());
        if (up.includes('DRIVERS') && up.some(c => c === 'CDL EXP')) {
          headerIdx = i;
          up.forEach((col, idx) => { colMap[col] = idx; });
          break;
        }
      }
      if (headerIdx === -1) continue;

      let section = 'active';
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const joined = row.join(' ').toUpperCase();

        if (joined.includes('INACTIVE DRIVERS')) { section = 'inactive'; continue; }
        if (joined.includes('ACTIVE DRIVERS')) { section = 'active'; continue; }
        if (row.map(c => c.toUpperCase().trim()).includes('DRIVERS') &&
            row.map(c => c.toUpperCase().trim()).some(c => c === 'CDL EXP')) {
          row.map(c => c.toUpperCase().trim()).forEach((col, idx) => { colMap[col] = idx; });
          continue;
        }

        const driver = row[colMap['DRIVERS'] ?? 2]?.trim();
        if (!driver || /^#?\d*$/.test(driver)) continue;

        const unit = row[colMap['UNIT'] ?? 1]?.trim() || '';

        for (const expCol of EXP_COLS) {
          const idx = colMap[expCol];
          if (idx === undefined) continue;
          const date = parseDate(row[idx]);
          if (date) {
            newRecords.push({ company, driver, unit, doc: expCol, date, status: section });
          }
        }
      }
      console.log(`✓ ${company}`);
    } catch (e) {
      errors.push(company);
      console.log(`✗ ${company}: ${e.message}`);
    }
  }

  records = newRecords;
  lastSync = new Date().toLocaleString('en-US');
  console.log(`Sync done: ${records.length} records`);
  return { total: records.length, errors };
}

async function sendAlerts(chatId, maxDays = 30) {
  const active = records.filter(r => r.status === 'active' && daysUntil(r.date) <= maxDays);

  if (active.length === 0) {
    return bot.sendMessage(chatId, '✅ All active driver documents are valid for 30+ days.');
  }

  const byCompany = {};
  for (const r of active) {
    if (!byCompany[r.company]) byCompany[r.company] = {};
    if (!byCompany[r.company][r.driver]) byCompany[r.company][r.driver] = [];
    byCompany[r.company][r.driver].push(r);
  }

  for (const [company, drivers] of Object.entries(byCompany)) {
    let msg = `🏢 *${company}*\n\n`;
    for (const [driver, docs] of Object.entries(drivers)) {
      msg += `👤 ${driver}\n`;
      for (const doc of docs) {
        const d = daysUntil(doc.date);
        const label = d < 0 ? `EXPIRED ${Math.abs(d)}d ago` : `${d}d left`;
        msg += `  ${emoji(d)} ${doc.doc}: ${fmtDate(doc.date)} *(${label})*\n`;
      }
      msg += '\n';
    }
    try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); }
    catch (e) { await bot.sendMessage(chatId, msg.replace(/[*_`[\]()~>#+=|{}.!-]/g, '')); }
  }
}

function mainMenu(chatId) {
  return bot.sendMessage(chatId,
    `👋 *Driver Expiration Bot*\n\n` +
    `🔴 Expired or <7 days\n` +
    `🟠 7–14 days\n` +
    `🟡 15–30 days\n` +
    `🟢 30+ days\n\n` +
    `Last sync: ${lastSync || 'Not yet'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔔 Check Expirations', callback_data: 'check' }],
          [{ text: '🔄 Sync Google Sheet', callback_data: 'sync' }],
          [{ text: '📋 Full List', callback_data: 'list' }, { text: '🏢 Companies', callback_data: 'companies' }],
        ]
      }
    }
  );
}

// /start
bot.onText(/\/start/, (msg) => mainMenu(msg.chat.id));

// Inline button handler
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  await bot.answerCallbackQuery(q.id);

  if (q.data === 'check') {
    if (records.length === 0) return bot.sendMessage(chatId, '⚠️ No data. Tap Sync first.');
    await bot.sendMessage(chatId, '🔍 Checking expiring documents...');
    await sendAlerts(chatId, 30);
    await mainMenu(chatId);
  }

  if (q.data === 'sync') {
    const m = await bot.sendMessage(chatId, '🔄 Syncing from Google Sheet...');
    try {
      const r = await syncSheet();
      await bot.editMessageText(
        `✅ Sync done!\n📊 ${r.total} records loaded\n` +
        (r.errors.length ? `⚠️ Failed: ${r.errors.join(', ')}` : '✅ All companies synced'),
        { chat_id: chatId, message_id: m.message_id }
      );
    } catch (e) {
      await bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chatId, message_id: m.message_id });
    }
    await mainMenu(chatId);
  }

  if (q.data === 'list') {
    const active = records.filter(r => r.status === 'active');
    if (active.length === 0) return bot.sendMessage(chatId, '📋 No data. Tap Sync first.');
    const byCompany = {};
    for (const r of active) {
      if (!byCompany[r.company]) byCompany[r.company] = {};
      if (!byCompany[r.company][r.driver]) byCompany[r.company][r.driver] = [];
      byCompany[r.company][r.driver].push(r);
    }
    for (const [company, drivers] of Object.entries(byCompany)) {
      let msg = `🏢 *${company}*\n\n`;
      for (const [driver, docs] of Object.entries(drivers)) {
        msg += `👤 ${driver}\n`;
        for (const doc of docs) {
          msg += `  ${emoji(daysUntil(doc.date))} ${doc.doc}: ${fmtDate(doc.date)}\n`;
        }
        msg += '\n';
      }
      try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); }
      catch (e) { await bot.sendMessage(chatId, msg.replace(/[*_[\]()~>#+=|{}.!]/g, '')); }
    }
    await mainMenu(chatId);
  }

  if (q.data === 'companies') {
    const companies = [...new Set(records.map(r => r.company))].sort();
    if (companies.length === 0) return bot.sendMessage(chatId, 'No data. Tap Sync first.');
    const text = companies.map((c, i) => {
      const count = records.filter(r => r.company === c && r.status === 'active').length;
      return `${i + 1}. ${c} (${count} docs)`;
    }).join('\n');
    await bot.sendMessage(chatId, `🏢 *Companies (${companies.length})*\n\n${text}`, { parse_mode: 'Markdown' });
    await mainMenu(chatId);
  }
});

// /sync
bot.onText(/\/sync/, async (msg) => {
  const m = await bot.sendMessage(msg.chat.id, '🔄 Syncing from Google Sheet...');
  try {
    const r = await syncSheet();
    bot.editMessageText(
      `✅ Sync done!\n📊 ${r.total} records loaded\n` +
      (r.errors.length ? `⚠️ Failed: ${r.errors.join(', ')}` : '✅ All companies synced'),
      { chat_id: msg.chat.id, message_id: m.message_id }
    );
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: msg.chat.id, message_id: m.message_id });
  }
});

// /check
bot.onText(/\/check/, async (msg) => {
  if (records.length === 0) return bot.sendMessage(msg.chat.id, '⚠️ No data. Use /sync first.');
  await bot.sendMessage(msg.chat.id, '🔍 Checking expiring documents...');
  await sendAlerts(msg.chat.id, 30);
});

// /list
bot.onText(/\/list/, async (msg) => {
  const active = records.filter(r => r.status === 'active');
  if (active.length === 0) return bot.sendMessage(msg.chat.id, '📋 No data. Use /sync first.');

  const byCompany = {};
  for (const r of active) {
    if (!byCompany[r.company]) byCompany[r.company] = {};
    if (!byCompany[r.company][r.driver]) byCompany[r.company][r.driver] = [];
    byCompany[r.company][r.driver].push(r);
  }

  for (const [company, drivers] of Object.entries(byCompany)) {
    let msg = `🏢 *${company}*\n\n`;
    for (const [driver, docs] of Object.entries(drivers)) {
      msg += `👤 ${driver}\n`;
      for (const doc of docs) {
        msg += `  ${emoji(daysUntil(doc.date))} ${doc.doc}: ${fmtDate(doc.date)}\n`;
      }
      msg += '\n';
    }
    try { await bot.sendMessage(msg.chat.id, msg, { parse_mode: 'Markdown' }); }
    catch (e) { await bot.sendMessage(msg.chat.id, msg.replace(/[*_[\]()~>#+=|{}.!]/g, '')); }
  }
});

// /companies
bot.onText(/\/companies/, (msg) => {
  const companies = [...new Set(records.map(r => r.company))].sort();
  if (companies.length === 0) return bot.sendMessage(msg.chat.id, 'No data. Use /sync first.');
  const text = companies.map((c, i) => {
    const count = records.filter(r => r.company === c && r.status === 'active').length;
    return `${i + 1}. ${c} (${count} docs)`;
  }).join('\n');
  bot.sendMessage(msg.chat.id, `🏢 *Companies (${companies.length})*\n\n${text}`, { parse_mode: 'Markdown' });
});

// Daily 8:00 AM
cron.schedule('0 8 * * *', async () => {
  if (!CHAT_ID) return;
  try {
    await bot.sendMessage(CHAT_ID, '🔔 *Daily Expiration Check*', { parse_mode: 'Markdown' });
    await sendAlerts(CHAT_ID, 30);
  } catch (e) { console.error('Daily alert error:', e.message); }
});

// Auto-sync every 1 minute
cron.schedule('* * * * *', async () => {
  try { await syncSheet(); }
  catch (e) { console.error('Auto-sync error:', e.message); }
});

// Keep Railway happy — bind to PORT
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((_req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`Health check listening on port ${PORT}`);
});

// Handle polling errors so bot doesn't crash
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// Startup sync
syncSheet()
  .then(r => console.log(`✅ Bot started. ${r.total} records synced.`))
  .catch(e => console.error('Startup sync failed:', e.message));

console.log('🤖 Driver Expiration Bot running...');
