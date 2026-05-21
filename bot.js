const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const Database = require('better-sqlite3');
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

const EXP_COLS = ['CDL EXP', 'MED CARD', 'CH EXP', 'MVR EXP', 'ANNUAL INSP'];

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Database('drivers.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    driver_name TEXT NOT NULL,
    unit TEXT,
    doc_type TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    driver_status TEXT DEFAULT 'active'
  )
`);

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
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
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
  if (!str || ['not yet','n/a','owner','-',''].includes(str.toLowerCase())) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function daysUntil(dateStr) {
  const t = new Date(); t.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - t) / 86400000);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function emoji(days) {
  if (days < 0) return '🔴';
  if (days <= 7) return '🔴';
  if (days <= 14) return '🟠';
  if (days <= 30) return '🟡';
  return '🟢';
}

async function syncSheet() {
  db.prepare('DELETE FROM documents').run();
  const ins = db.prepare('INSERT INTO documents (company, driver_name, unit, doc_type, expiry_date, driver_status) VALUES (?,?,?,?,?,?)');
  let total = 0, errors = [];

  for (const company of COMPANY_SHEETS) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(company)}`;
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
      if (headerIdx === -1) { console.log(`No header: ${company}`); continue; }

      let section = 'active';
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const joined = row.join(' ').toUpperCase();

        if (joined.includes('INACTIVE DRIVERS')) { section = 'inactive'; continue; }
        if (joined.includes('ACTIVE DRIVERS')) { section = 'active'; continue; }
        if (row.map(c=>c.toUpperCase().trim()).includes('DRIVERS') && row.map(c=>c.toUpperCase().trim()).some(c=>c==='CDL EXP')) {
          row.map(c=>c.toUpperCase().trim()).forEach((col,idx) => { colMap[col]=idx; });
          continue;
        }

        const driverIdx = colMap['DRIVERS'] ?? 2;
        const driver = row[driverIdx]?.trim();
        if (!driver || /^#?\d*$/.test(driver)) continue;

        const unit = row[colMap['UNIT'] ?? 1]?.trim() || '';

        for (const expCol of EXP_COLS) {
          const idx = colMap[expCol];
          if (idx === undefined) continue;
          const date = parseDate(row[idx]);
          if (date) { ins.run(company, driver, unit, expCol, date, section); total++; }
        }
      }
      console.log(`✓ ${company}`);
    } catch (e) {
      errors.push(company);
      console.log(`✗ ${company}: ${e.message}`);
    }
  }
  return { total, errors };
}

async function sendAlerts(chatId, maxDays = 30) {
  const rows = db.prepare('SELECT * FROM documents WHERE driver_status=? ORDER BY expiry_date ASC').all('active');
  const filtered = rows.filter(r => daysUntil(r.expiry_date) <= maxDays);

  if (filtered.length === 0) {
    return bot.sendMessage(chatId, '✅ All active driver documents are valid for 30+ days.');
  }

  const byCompany = {};
  for (const row of filtered) {
    if (!byCompany[row.company]) byCompany[row.company] = {};
    if (!byCompany[row.company][row.driver_name]) byCompany[row.company][row.driver_name] = [];
    byCompany[row.company][row.driver_name].push(row);
  }

  for (const [company, drivers] of Object.entries(byCompany)) {
    let msg = `🏢 *${company}*\n\n`;
    for (const [driver, docs] of Object.entries(drivers)) {
      msg += `👤 ${driver}\n`;
      for (const doc of docs) {
        const d = daysUntil(doc.expiry_date);
        const label = d < 0 ? `EXPIRED ${Math.abs(d)}d ago` : `${d}d left`;
        msg += `  ${emoji(d)} ${doc.doc_type}: ${fmtDate(doc.expiry_date)} *(${label})*\n`;
      }
      msg += '\n';
    }
    try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); }
    catch (e) { await bot.sendMessage(chatId, msg.replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')); }
  }
}

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Driver Expiration Bot*\n\n` +
    `🔴 Red = expired or <7 days\n` +
    `🟠 Orange = 7–14 days\n` +
    `🟡 Yellow = 14–30 days\n` +
    `🟢 Green = 30+ days\n\n` +
    `*Commands:*\n` +
    `🔔 /check — Expiring within 30 days\n` +
    `📋 /list — All active drivers\n` +
    `🔄 /sync — Sync from Google Sheet\n` +
    `🏢 /companies — List all companies`,
    { parse_mode: 'Markdown' }
  );
});

// /sync
bot.onText(/\/sync/, async (msg) => {
  const m = await bot.sendMessage(msg.chat.id, '🔄 Syncing from Google Sheet...');
  try {
    const r = await syncSheet();
    const count = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;
    await bot.editMessageText(
      `✅ Sync done!\n📊 ${count} records loaded\n` +
      (r.errors.length ? `⚠️ Failed: ${r.errors.join(', ')}` : ''),
      { chat_id: msg.chat.id, message_id: m.message_id }
    );
  } catch (e) {
    bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: msg.chat.id, message_id: m.message_id });
  }
});

// /check
bot.onText(/\/check/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔍 Checking expiring documents...');
  await sendAlerts(msg.chat.id, 30);
});

// /list
bot.onText(/\/list/, async (msg) => {
  const rows = db.prepare('SELECT * FROM documents WHERE driver_status=? ORDER BY company, driver_name, expiry_date').all('active');
  if (rows.length === 0) return bot.sendMessage(msg.chat.id, '📋 No data. Use /sync first.');

  const byCompany = {};
  for (const row of rows) {
    if (!byCompany[row.company]) byCompany[row.company] = {};
    if (!byCompany[row.company][row.driver_name]) byCompany[row.company][row.driver_name] = [];
    byCompany[row.company][row.driver_name].push(row);
  }

  for (const [company, drivers] of Object.entries(byCompany)) {
    let msg = `🏢 *${company}*\n\n`;
    for (const [driver, docs] of Object.entries(drivers)) {
      msg += `👤 ${driver}\n`;
      for (const doc of docs) {
        msg += `  ${emoji(daysUntil(doc.expiry_date))} ${doc.doc_type}: ${fmtDate(doc.expiry_date)}\n`;
      }
      msg += '\n';
    }
    try { await bot.sendMessage(msg.chat.id, msg, { parse_mode: 'Markdown' }); }
    catch (e) { await bot.sendMessage(msg.chat.id, msg.replace(/[*_[\]()~>#+=|{}.!]/g, '')); }
  }
});

// /companies
bot.onText(/\/companies/, (msg) => {
  const list = db.prepare('SELECT DISTINCT company, COUNT(*) as c FROM documents WHERE driver_status=? GROUP BY company ORDER BY company').all('active');
  if (list.length === 0) return bot.sendMessage(msg.chat.id, 'No data. Use /sync first.');
  const text = list.map((r,i) => `${i+1}. ${r.company} (${r.c} docs)`).join('\n');
  bot.sendMessage(msg.chat.id, `🏢 *Companies (${list.length})*\n\n${text}`, { parse_mode: 'Markdown' });
});

// Daily 8:00 AM alert
cron.schedule('0 8 * * *', async () => {
  if (!CHAT_ID) return;
  try {
    await bot.sendMessage(CHAT_ID, '🔔 *Daily Expiration Check*', { parse_mode: 'Markdown' });
    await sendAlerts(CHAT_ID, 30);
  } catch (e) { console.error('Daily alert error:', e.message); }
});

// Auto-sync every 6 hours
cron.schedule('0 */6 * * *', async () => {
  try { const r = await syncSheet(); console.log(`Auto-sync: ${r.total} records`); }
  catch (e) { console.error('Auto-sync error:', e.message); }
});

// Sync on startup
syncSheet()
  .then(r => console.log(`✅ Started. Synced ${r.total} records`))
  .catch(e => console.error('Startup sync error:', e.message));

console.log('🤖 Driver Expiration Bot running...');
