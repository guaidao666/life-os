import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'life.db');
// Obsidian vault 路径（不写个人信息进仓库）：
// 优先读本地 .vaultpath（该文件已加入 .gitignore，不进仓库），其次环境变量 OBSIDIAN_VAULT，最后用通用占位。
const VAULT = (() => {
  try { const p = readFileSync(path.join(__dirname, '.vaultpath'), 'utf8').trim(); if (p) return p; } catch {}
  if (process.env.OBSIDIAN_VAULT) return process.env.OBSIDIAN_VAULT;
  return 'D:/obsidian_wks/我的知识库';
})();
const PY = 'C:/Users/WKS/.workbuddy/binaries/python/versions/3.13.12/python.exe';

const defaultTheme = {
  colors: { purple: '#af52de', cyan: '#5ac8fa', indigo: '#5856d6', blue: '#0071e3', green: '#34c759', orange: '#ff9500', pink: '#ff375f' },
  dark: false
};

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT, priority TEXT, done INTEGER DEFAULT 0, points INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS diet_logs (id INTEGER PRIMARY KEY, date TEXT, meal TEXT, name TEXT, cal INTEGER);
  CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT, category TEXT, cost TEXT, steps TEXT, source TEXT);
  CREATE TABLE IF NOT EXISTS exercises (id INTEGER PRIMARY KEY, date TEXT, type TEXT, min INTEGER, cal INTEGER);
  CREATE TABLE IF NOT EXISTS finances (id INTEGER PRIMARY KEY, date TEXT, type TEXT, category TEXT, amount REAL, note TEXT);
  CREATE TABLE IF NOT EXISTS price_items (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, category TEXT, unit TEXT, price REAL, unit_price REAL, date TEXT, shop TEXT, note TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, pages INTEGER, read INTEGER, intro TEXT, content TEXT);
  CREATE TABLE IF NOT EXISTS book_notes (id INTEGER PRIMARY KEY, book_id INTEGER, date TEXT, text TEXT);
  CREATE TABLE IF NOT EXISTS english_words (id INTEGER PRIMARY KEY, word TEXT, meaning TEXT, date TEXT, review INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, title TEXT, type TEXT, source TEXT, content TEXT, done INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS resources (id INTEGER PRIMARY KEY, title TEXT, source TEXT, summary TEXT);
  CREATE TABLE IF NOT EXISTS cook_posts (id INTEGER PRIMARY KEY, date TEXT, dish TEXT, feeling TEXT, rating INTEGER DEFAULT 0, recipe_id INTEGER, images TEXT);
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY, date TEXT, meal TEXT, type TEXT, recipe_id INTEGER,
    name TEXT, cal INTEGER DEFAULT 0, images TEXT, feeling TEXT, rating INTEGER DEFAULT 0, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS menus (
    id INTEGER PRIMARY KEY, date TEXT, name TEXT, people INTEGER DEFAULT 1,
    scene TEXT, taste TEXT, complexity TEXT, items TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS shopping_items (
    id INTEGER PRIMARY KEY, menu_id INTEGER, name TEXT, category TEXT,
    qty TEXT, unit TEXT, checked INTEGER DEFAULT 0, note TEXT
  );
  CREATE TABLE IF NOT EXISTS pantry (
    id INTEGER PRIMARY KEY, name TEXT, category TEXT, qty TEXT, unit TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS player_stats (
    id INTEGER PRIMARY KEY, willpower REAL DEFAULT 0, starwish REAL DEFAULT 0,
    contract INTEGER DEFAULT 0, level INTEGER DEFAULT 1, skills TEXT, realms TEXT
  );
  CREATE TABLE IF NOT EXISTS help_docs (id INTEGER PRIMARY KEY, content TEXT);
  CREATE TABLE IF NOT EXISTS wishlist (id INTEGER PRIMARY KEY, name TEXT, required_stars REAL, done INTEGER DEFAULT 0, note TEXT);
  CREATE TABLE IF NOT EXISTS taskboard (id INTEGER PRIMARY KEY, grp TEXT, text TEXT, depth INTEGER DEFAULT 0, done INTEGER DEFAULT 0, points INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS diary (id INTEGER PRIMARY KEY, date TEXT, title TEXT, content TEXT, mood TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS reward_log (
    id INTEGER PRIMARY KEY, ts TEXT, source TEXT, text TEXT,
    dw REAL DEFAULT 0, dsw REAL DEFAULT 0, bw REAL DEFAULT 0, bsw REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS entertainment (
    id INTEGER PRIMARY KEY, type TEXT, title TEXT, status TEXT, rating REAL DEFAULT 0,
    tags TEXT DEFAULT '[]', url TEXT, note TEXT, plot TEXT, quotes TEXT, review TEXT,
    cover TEXT, created_at TEXT
  );
`);

// 迁移：taskboard 增加 done_at（记录完成时间，用于日/周自动刷新）
try { db.exec('ALTER TABLE taskboard ADD COLUMN done_at TEXT'); } catch (e) { /* 列已存在则忽略 */ }
// 迁移：taskboard 增加 ord（组内排序，用于拖动排序）
try { db.exec('ALTER TABLE taskboard ADD COLUMN ord INTEGER DEFAULT 0'); } catch (e) { /* 列已存在则忽略 */ }
// 迁移：todos 增加 points（每条待办自定义愿力点，默认 1）
try { db.exec('ALTER TABLE todos ADD COLUMN points INTEGER DEFAULT 1'); } catch (e) { /* 列已存在则忽略 */ }
// 迁移：recipes 增加扩展字段（时间/难度/食材/标签/封面，用于饮食中心）
try { db.exec('ALTER TABLE recipes ADD COLUMN time INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE recipes ADD COLUMN difficulty INTEGER DEFAULT 2'); } catch (e) {}
try { db.exec('ALTER TABLE recipes ADD COLUMN ingredients TEXT DEFAULT \'[]\''); } catch (e) {}
try { db.exec('ALTER TABLE recipes ADD COLUMN tags TEXT DEFAULT \'[]\''); } catch (e) {}
try { db.exec('ALTER TABLE recipes ADD COLUMN image TEXT DEFAULT \'\''); } catch (e) {}
// 迁移：cook_posts / diet_logs → meals（合并饮食数据，type=cook 自己做 / eat_out 外食）
try {
  db.exec(`INSERT INTO meals (id,date,meal,type,recipe_id,name,cal,images,feeling,rating)
    SELECT id,date,'晚餐','cook',recipe_id,dish,0,images,feeling,rating FROM cook_posts
    WHERE NOT EXISTS (SELECT 1 FROM meals m WHERE m.id = cook_posts.id)`);
} catch (e) {}
try {
  db.exec(`INSERT INTO meals (id,date,meal,type,recipe_id,name,cal,images,feeling,rating)
    SELECT id,date,meal,'eat_out',NULL,name,cal,'[]','','0' FROM diet_logs
    WHERE NOT EXISTS (SELECT 1 FROM meals m WHERE m.id = diet_logs.id)`);
} catch (e) {}

const getSetting = (k, d) => {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return row ? row.value : d;
};

// 初始化玩家数值（首行 id=1，仅插入一次）。可按需修改默认值。
function ensurePlayer() {
  const row = db.prepare('SELECT id FROM player_stats WHERE id=1').get();
  if (!row) {
    const defaultSkills = { "陶笛":0, "围棋":1, "PS":1, "Python":1, "画画":0, "广联达":0, "Office":2 };
    const defaultRealms = {
      "炼体法":"八段锦 — 散炼境", "万卷书":"甲百卷（141/200）", "万里路":"甲十级（11/20）",
      "功德法":"渡人境", "千面法":"理智面 · 感性思维"
    };
    db.prepare('INSERT INTO player_stats (id, willpower, starwish, contract, level, skills, realms) VALUES (?,?,?,?,?,?,?)')
      .run(1, 952.5, 7, 3, 7, JSON.stringify(defaultSkills), JSON.stringify(defaultRealms));
  }
}
ensurePlayer();

function safeParse(v, d) {
  try { return JSON.parse(v); } catch { return d; }
}

function num(v) {
  if (v === undefined || v === null) return 0;
  const s = String(v).replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function readData() {
  const todos = db.prepare('SELECT id,text,priority,done,points FROM todos').all()
    .map(r => ({ id: r.id, text: r.text, priority: r.priority, done: !!r.done, points: r.points != null ? r.points : 1 }));
  const meals = db.prepare('SELECT id,date,meal,type,recipe_id,name,cal,images,feeling,rating FROM meals ORDER BY date DESC, id DESC').all()
    .map(r => ({ id: r.id, date: r.date, meal: r.meal || '', type: r.type || 'cook', recipeId: r.recipe_id, name: r.name || '', cal: r.cal || 0, images: r.images ? JSON.parse(r.images) : [], feeling: r.feeling || '', rating: r.rating || 0 }));
  const recipes = db.prepare('SELECT id,name,category,cost,steps,source,time,difficulty,ingredients,tags,image FROM recipes').all()
    .map(r => ({ id: r.id, name: r.name, category: r.category, cost: r.cost, steps: r.steps, source: r.source, time: r.time || 0, difficulty: r.difficulty || 2, ingredients: r.ingredients ? JSON.parse(r.ingredients) : [], tags: r.tags ? JSON.parse(r.tags) : [], image: r.image || '' }));
  const exercises = db.prepare('SELECT id,date,type,min,cal,distance FROM exercises').all()
    .map(r => ({ id: r.id, date: r.date, type: r.type, min: r.min, cal: r.cal, distance: r.distance }));
  const fin = db.prepare('SELECT id,date,type,category,amount,note FROM finances').all()
    .map(r => ({ id: r.id, date: r.date, type: r.type, category: r.category, amount: r.amount, note: r.note }));
  const priceItems = db.prepare('SELECT id,kind,name,category,unit,price,unit_price,date,shop,note,status FROM price_items').all()
    .map(r => ({ id: r.id, kind: r.kind, name: r.name, category: r.category, unit: r.unit, price: r.price, unitPrice: r.unit_price, date: r.date, shop: r.shop, note: r.note, status: r.status }));
  const booksRaw = db.prepare('SELECT id,title,author,pages,read,intro,content FROM books').all();
  const books = booksRaw.map(b => ({
    id: b.id, title: b.title, author: b.author, pages: b.pages, read: b.read,
    intro: b.intro || '', content: b.content || '',
    notes: db.prepare('SELECT id,date,text FROM book_notes WHERE book_id=?').all(b.id)
      .map(n => ({ id: n.id, date: n.date, text: n.text }))
  }));
  const words = db.prepare('SELECT id,word,meaning,date,review FROM english_words').all()
    .map(r => ({ id: r.id, word: r.word, meaning: r.meaning, date: r.date, review: r.review }));
  const projects = db.prepare('SELECT id,title,type,source,content,done FROM projects').all()
    .map(r => ({ id: r.id, title: r.title, type: r.type, source: r.source, content: r.content, done: !!r.done }));
  const resources = db.prepare('SELECT id,title,source,summary FROM resources').all()
    .map(r => ({ id: r.id, title: r.title, source: r.source, summary: r.summary }));
  const helpDoc = db.prepare('SELECT content FROM help_docs WHERE id=1').get();
  const help = helpDoc ? helpDoc.content : '';
  const wishlist = db.prepare('SELECT id,name,required_stars,done,note FROM wishlist').all()
    .map(r => ({ id: r.id, name: r.name, requiredStars: r.required_stars, done: !!r.done, note: r.note }));

  const taskboard = db.prepare('SELECT id,grp,text,depth,done,points,done_at,ord FROM taskboard ORDER BY grp, ord, id').all()
    .map(r => ({ id: r.id, grp: r.grp, text: r.text, depth: r.depth, done: !!r.done, points: r.points, done_at: r.done_at || '', ord: r.ord || 0 }));

  const diary = db.prepare('SELECT id,date,title,content,mood,created_at FROM diary ORDER BY date DESC, id DESC').all()
    .map(r => ({ id: r.id, date: r.date || '', title: r.title || '', content: r.content || '', mood: r.mood || '', created_at: r.created_at || '' }));

  const entertainment = db.prepare('SELECT id,type,title,status,rating,tags,url,note,plot,quotes,review,cover,created_at FROM entertainment').all()
    .map(r => ({ id: r.id, type: r.type || '', title: r.title || '', status: r.status || '', rating: r.rating || 0, tags: r.tags ? safeParse(r.tags, []) : [], url: r.url || '', note: r.note || '', plot: r.plot || '', quotes: r.quotes || '', review: r.review || '', cover: r.cover || '', createdAt: r.created_at || '' }));

  const rewardLog = db.prepare('SELECT id,ts,source,text,dw,dsw,bw,bsw FROM reward_log ORDER BY ts DESC, id DESC LIMIT 50').all()
    .map(r => ({ id: r.id, ts: r.ts || '', source: r.source || '', text: r.text || '', dw: r.dw || 0, dsw: r.dsw || 0, bw: r.bw || 0, bsw: r.bsw || 0 }));

  const menus = db.prepare('SELECT id,date,name,people,scene,taste,complexity,items,created_at FROM menus ORDER BY created_at DESC, id DESC').all()
    .map(r => ({ id: r.id, date: r.date || '', name: r.name || '', people: r.people || 1, scene: r.scene || '', taste: r.taste || '', complexity: r.complexity || '', items: r.items ? safeParse(r.items, []) : [], createdAt: r.created_at || '' }));
  const shopping = db.prepare('SELECT id,menu_id,name,category,qty,unit,checked,note FROM shopping_items').all()
    .map(r => ({ id: r.id, menuId: r.menu_id, name: r.name || '', category: r.category || '其他', qty: r.qty || '', unit: r.unit || '', checked: !!r.checked, note: r.note || '' }));
  const pantry = db.prepare('SELECT id,name,category,qty,unit,note FROM pantry').all()
    .map(r => ({ id: r.id, name: r.name || '', category: r.category || '其他', qty: r.qty || '', unit: r.unit || '', note: r.note || '' }));

  const pRow = db.prepare('SELECT willpower,starwish,contract,level,skills,realms FROM player_stats WHERE id=1').get();
  const player = pRow ? {
    willpower: pRow.willpower, starwish: pRow.starwish, contract: pRow.contract, level: pRow.level,
    skills: safeParse(pRow.skills, {}), realms: safeParse(pRow.realms, {})
  } : { willpower: 0, starwish: 0, contract: 0, level: 1, skills: {}, realms: {} };

  let theme = defaultTheme;
  try { theme = JSON.parse(getSetting('theme', JSON.stringify(defaultTheme))); } catch {}
  const dietGoal = parseInt(getSetting('diet_goal', '2000')) || 2000;
  const enGoal = parseInt(getSetting('english_goal', '20')) || 20;

  return {
    todos,
    food: { meals, goal: dietGoal, recipes, menus, shopping, pantry },
    exercise: { logs: exercises },
    finance: { records: fin, priceItems },
    books,
    english: { words, dailyGoal: enGoal },
    projects,
    resources,
    help,
    wishlist,
    player,
    taskboard,
    diary,
    rewardLog,
    entertainment,
    theme
  };
}

function writeData(obj) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM todos; DELETE FROM diet_logs; DELETE FROM recipes; DELETE FROM exercises; DELETE FROM finances; DELETE FROM price_items; DELETE FROM books; DELETE FROM book_notes; DELETE FROM english_words; DELETE FROM projects; DELETE FROM resources; DELETE FROM cook_posts; DELETE FROM meals; DELETE FROM menus; DELETE FROM shopping_items; DELETE FROM pantry; DELETE FROM settings;');
    const insTodo = db.prepare('INSERT INTO todos (id,text,priority,done,points) VALUES (?,?,?,?,?)');
    (obj.todos || []).forEach(t => insTodo.run(t.id, t.text, t.priority, t.done ? 1 : 0, t.points || 1));
    const insRecipe = db.prepare('INSERT INTO recipes (id,name,category,cost,steps,source,time,difficulty,ingredients,tags,image) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    (obj.food?.recipes || []).forEach(r => insRecipe.run(r.id, r.name, r.category, r.cost, r.steps, r.source, r.time || 0, r.difficulty || 2, JSON.stringify(r.ingredients || []), JSON.stringify(r.tags || []), r.image || ''));
    const insEx = db.prepare('INSERT INTO exercises (id,date,type,min,cal,distance) VALUES (?,?,?,?,?,?)');
    (obj.exercise?.logs || []).forEach(l => insEx.run(l.id, l.date, l.type, l.min, l.cal, l.distance));
    const insFin = db.prepare('INSERT INTO finances (id,date,type,category,amount,note) VALUES (?,?,?,?,?,?)');
    (obj.finance?.records || []).forEach(r => insFin.run(r.id, r.date, r.type, r.category, r.amount, r.note || ''));
    const insPrice = db.prepare('INSERT INTO price_items (id,kind,name,category,unit,price,unit_price,date,shop,note,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    (obj.finance?.priceItems || []).forEach(r => insPrice.run(r.id, r.kind, r.name, r.category, r.unit, num(r.price), num(r.unitPrice), r.date, r.shop, r.note, r.status));
    const insBook = db.prepare('INSERT INTO books (id,title,author,pages,read,intro,content) VALUES (?,?,?,?,?,?,?)');
    const insNote = db.prepare('INSERT INTO book_notes (id,book_id,date,text) VALUES (?,?,?,?)');
    (obj.books || []).forEach(b => {
      insBook.run(b.id, b.title, b.author || '', b.pages, b.read, b.intro || '', b.content || '');
      (b.notes || []).forEach(n => insNote.run(n.id, b.id, n.date, n.text));
    });
    const insWord = db.prepare('INSERT INTO english_words (id,word,meaning,date,review) VALUES (?,?,?,?,?)');
    (obj.english?.words || []).forEach(w => insWord.run(w.id, w.word, w.meaning, w.date, w.review || 0));
    const insProj = db.prepare('INSERT INTO projects (id,title,type,source,content,done) VALUES (?,?,?,?,?,?)');
    (obj.projects || []).forEach(p => insProj.run(p.id, p.title, p.type, p.source, p.content, p.done ? 1 : 0));
    const insRes = db.prepare('INSERT INTO resources (id,title,source,summary) VALUES (?,?,?,?)');
    (obj.resources || []).forEach(r => insRes.run(r.id, r.title, r.source, r.summary));
    const insMeal = db.prepare('INSERT INTO meals (id,date,meal,type,recipe_id,name,cal,images,feeling,rating) VALUES (?,?,?,?,?,?,?,?,?,?)');
    (obj.food?.meals || []).forEach(m => insMeal.run(m.id, m.date, m.meal || '', m.type || 'cook', m.recipeId || null, m.name || '', m.cal || 0, JSON.stringify(m.images || []), m.feeling || '', m.rating || 0));
    const insSet = db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
    insSet.run('diet_goal', String(obj.food?.goal ?? 2000));
    insSet.run('english_goal', String(obj.english?.dailyGoal ?? 20));
    insSet.run('theme', JSON.stringify(obj.theme || defaultTheme));
    const insMenu = db.prepare('INSERT INTO menus (id,date,name,people,scene,taste,complexity,items,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    (obj.food?.menus || []).forEach(m => insMenu.run(m.id, m.date || new Date().toISOString().slice(0,10), m.name || '一桌菜', m.people || 1, m.scene || '', m.taste || '', m.complexity || '', JSON.stringify(m.items || []), m.createdAt || new Date().toISOString()));
    const insShop = db.prepare('INSERT INTO shopping_items (id,menu_id,name,category,qty,unit,checked,note) VALUES (?,?,?,?,?,?,?,?)');
    (obj.food?.shopping || []).forEach(s => insShop.run(s.id, s.menuId || null, s.name || '', s.category || '其他', s.qty || '', s.unit || '', s.checked ? 1 : 0, s.note || ''));
    const insPantry = db.prepare('INSERT INTO pantry (id,name,category,qty,unit,note) VALUES (?,?,?,?,?,?)');
    (obj.food?.pantry || []).forEach(p => insPantry.run(p.id, p.name || '', p.category || '其他', p.qty || '', p.unit || '', p.note || ''));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- Obsidian 一次性迁移 ----
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  m[1].split('\n').forEach(l => {
    const i = l.indexOf(':');
    if (i > 0) {
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      fm[k] = v;
    }
  });
  return { fm, body: text.slice(m[0].length) };
}
function listMd(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }));
}
function listMdRecursive(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMdRecursive(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push({ name: e.name, path: p });
  }
  return out;
}
function stripObsidian(text) {
  return text.replace(/^---[\s\S]*?---/, '').replace(/!\[\[.*?\]\]/g, '').replace(/^#.*$/gm, '').trim();
}
function readMdSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

function parseObsidian() {
  const data = {
    todos: [], food: { meals: [], goal: 2000, recipes: [] }, exercise: { logs: [] },
    finance: { records: [], priceItems: [] }, books: [],
    english: { words: [], dailyGoal: 20 }, projects: [], resources: [], theme: defaultTheme
  };
  let id = 1;

  // 1. 每日计划 <- 每日清单.md
  const checklist = readMdSafe(path.join(VAULT, '人生管理/每日清单.md'));
  checklist.split('\n').forEach(line => {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (m) data.todos.push({ id: id++, text: m[2].replace(/\[\[(.+?)\]\]/g, '$1'), priority: 'mid', done: m[1].toLowerCase() === 'x' });
  });

  // 2. 菜谱库 <- 生活/饮食
  const dietDir = path.join(VAULT, '生活/饮食');
  const menuText = readMdSafe(path.join(dietDir, '00-菜单.md'));
  const menuMap = {};
  menuText.split('\n').forEach(line => {
    if (!line.includes('|')) return;
    const cells = line.split('|').map(s => s.trim()).filter(s => s.length);
    if (cells.length >= 2) {
      const name = cells[0].replace(/\[\[(.+?)\]\]/g, '$1').replace(/\s/g, '');
      const cost = cells[cells.length - 1].replace(/\s/g, '');
      if (name && /[一-龥]/.test(name)) menuMap[name] = cost;
    }
  });
  const EXCLUDE = new Set(['README.md', '00-菜单.md', '作息与做饭节奏.md', '厨房安全须知.md', '换气记录.md', '新手菜谱.md']);
  listMd(dietDir).filter(f => !EXCLUDE.has(f.name)).forEach(f => {
    const name = f.name.replace(/\.md$/, '');
    const body = stripObsidian(readMdSafe(f.path));
    const m = menuMap[name];
    data.food.recipes.push({ id: id++, name, category: '菜谱', cost: m || '', steps: body.slice(0, 800), source: '生活/饮食/' + f.name });
  });

  // 3. 物价库 <- 生活物价库.xlsx
  const xlsxPath = path.join(VAULT, '生活/生活物价库.xlsx');
  if (existsSync(xlsxPath)) {
    try {
      const r = spawnSync(PY, [path.join(__dirname, 'parse_xlsx.py'), xlsxPath], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 50 });
      if (r.status === 0) {
        const sheets = JSON.parse(r.stdout.toString('utf8'));
        sheets.forEach(sheet => {
          sheet.records.forEach(rec => {
            if (sheet.sheet === '食材') {
              data.finance.priceItems.push({ id: id++, kind: '食材', name: rec['材料'] || '', category: rec['类型'] || '', unit: rec['单位'] || '', price: num(rec['购买价(元)']), unitPrice: num(rec['单价(元/单位)']), date: rec['日期'] || '', shop: rec['店铺'] || '', note: rec['备注'] || '', status: '' });
            } else {
              const cat = rec['功能'] || rec['功能/用途'] || '';
              data.finance.priceItems.push({ id: id++, kind: sheet.sheet, name: rec['物品'] || '', category: cat, unit: '', price: num(rec['购买价(元)']), unitPrice: 0, date: rec['日期'] || '', shop: '', note: rec['备注'] || '', status: rec['状态'] || '' });
            }
          });
        });
      }
    } catch (e) { console.error('xlsx parse failed', e); }
  }

  // 4. 读书收获 <- 娱乐/书籍
  const booksDir = path.join(VAULT, '娱乐/书籍');
  listMd(booksDir).filter(f => !f.name.toLowerCase().includes('readme')).forEach(f => {
    const text = readMdSafe(f.path);
    const { fm, body } = parseFrontmatter(text);
    const introM = body.match(/##\s*简介\s*\n([\s\S]*?)(?=\n##\s|$)/);
    const intro = introM ? introM[1].trim().slice(0, 500) : '';
    const content = stripObsidian(body).slice(0, 800);
    data.books.push({ id: id++, title: fm.title || f.name.replace(/\.md$/, ''), author: '', pages: 0, read: 0, intro, content });
  });

  // 6. 项目/目标 <- 任务板 + 人生管理
  const addProjects = (dir, type) => {
    listMdRecursive(dir).forEach(f => {
      if (f.name.toLowerCase().includes('readme')) return;
      const text = readMdSafe(f.path);
      const { fm } = parseFrontmatter(text);
      const title = fm.title || f.name.replace(/\.md$/, '');
      const content = stripObsidian(text).slice(0, 800);
      data.projects.push({ id: id++, title, type, source: path.relative(VAULT, f.path).replace(/\\/g, '/'), content, done: 0 });
    });
  };
  addProjects(path.join(VAULT, '人生管理/任务板'), 'task');
  addProjects(path.join(VAULT, '人生管理/人生管理'), 'goal');

  // 7. 资料库 <- 学习/学习笔记
  const studyDir = path.join(VAULT, '学习/学习笔记');
  listMd(studyDir).filter(f => !f.name.toLowerCase().includes('readme')).forEach(f => {
    const text = readMdSafe(f.path);
    const { fm } = parseFrontmatter(text);
    const summary = stripObsidian(text).slice(0, 400);
    data.resources.push({ id: id++, title: fm.title || f.name.replace(/\.md$/, ''), source: path.relative(VAULT, f.path).replace(/\\/g, '/'), summary });
  });

  return data;
}

// ---- 按模块导出 CSV（单表备份）----
const CSV_TABLES = {
  todos:         { label: '待办',     cols: [['id','ID'],['text','内容'],['priority','优先级'],['done','完成']] },
  meals:         { label: '饮食日志', cols: [['id','ID'],['date','日期'],['meal','餐次'],['type','类型'],['recipe_id','菜谱ID'],['name','名称'],['cal','热量'],['feeling','感受'],['rating','评分']] },
  recipes:       { label: '菜谱',     cols: [['id','ID'],['name','菜名'],['category','分类'],['cost','成本价'],['time','分钟'],['difficulty','难度'],['ingredients','食材'],['tags','标签'],['steps','做法'],['source','来源']] },
  exercises:     { label: '运动',     cols: [['id','ID'],['date','日期'],['type','类型'],['min','时长(分)'],['cal','热量']] },
  finances:      { label: '记账',     cols: [['id','ID'],['date','日期'],['type','类型'],['category','类别'],['amount','金额'],['note','备注']] },
  price_items:   { label: '物价库',   cols: [['id','ID'],['kind','类别'],['name','名称'],['category','类型'],['unit','单位'],['price','购买价'],['unit_price','单价'],['date','日期'],['shop','店铺'],['note','备注'],['status','状态']] },
  books:         { label: '读书',     cols: [['id','ID'],['title','书名'],['author','作者'],['pages','页数'],['read','已读'],['intro','简介']] },
  book_notes:    { label: '读书笔记', cols: [['id','ID'],['book_id','书ID'],['date','日期'],['text','笔记']] },
  english_words: { label: '英语单词', cols: [['id','ID'],['word','单词'],['meaning','释义'],['date','日期'],['review','复习次数']] },
  projects:      { label: '项目目标', cols: [['id','ID'],['title','标题'],['type','类型'],['source','来源'],['content','内容'],['done','完成']] },
  resources:     { label: '资料库',   cols: [['id','ID'],['title','标题'],['source','来源'],['summary','摘要']] },
  menus:         { label: '餐桌规划', cols: [['id','ID'],['date','日期'],['name','名称'],['people','人数'],['scene','场景'],['taste','口味'],['complexity','复杂度'],['items','菜品']] },
  shopping_items:{ label: '采购清单', cols: [['id','ID'],['menu_id','菜单ID'],['name','名称'],['category','分类'],['qty','数量'],['unit','单位'],['checked','已购'],['note','备注']] },
  pantry:        { label: '我的冰箱', cols: [['id','ID'],['name','名称'],['category','分类'],['qty','数量'],['unit','单位'],['note','备注']] },
};

function toCSV(rows, cols) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = cols.map(c => esc(c[1])).join(',');
  const body = rows.map(r => cols.map(c => esc(r[c[0]])).join(',')).join('\n');
  return '﻿' + head + '\n' + body;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',   '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
};

function sendCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  sendCORS(res);
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readData()));
    return;
  }

  if (req.method === 'POST' && url === '/api/data') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        writeData(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
      }
    });
    return;
  }

  // 一次性从 Obsidian 迁移
  if (req.method === 'POST' && url === '/api/import/obsidian') {
    try {
      const imported = parseObsidian();
      writeData(imported);
      const counts = {
        todos: imported.todos.length, recipes: imported.diet.recipes.length,
        priceItems: imported.finance.priceItems.length, books: imported.books.length,
        projects: imported.projects.length, resources: imported.resources.length
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, counts }));
    } catch (e) {
      console.error('IMPORT ERROR STACK:', e && e.stack ? e.stack : e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 按模块导出 CSV（单表备份）
  if (req.method === 'GET' && url === '/api/export/csv') {
    const table = new URL(req.url, 'http://x').searchParams.get('table');
    if (!table || !CSV_TABLES[table]) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('invalid table');
      return;
    }
    const meta = CSV_TABLES[table];
    const cols = meta.cols.map(c => c[0]).join(',');
    let rows = db.prepare('SELECT ' + cols + ' FROM ' + table).all();
    if (table === 'todos') rows = rows.map(r => ({ ...r, done: r.done ? '是' : '否' }));
    if (table === 'projects') rows = rows.map(r => ({ ...r, done: r.done ? '是' : '否' }));
    const csv = toCSV(rows, meta.cols);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(meta.label) + '.csv"'
    });
    res.end(csv);
    return;
  }

  // 增量写入：新增一条做菜记录（写入 meals 表，type='cook'，不动其他 13 张表）
  if (req.method === 'POST' && url === '/api/cook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        const dish = String(p.dish || '').trim();
        if (!dish) throw new Error('dish(菜名) 不能为空');
        const id = Date.now();
        const date = String(p.date || new Date().toISOString().slice(0, 10));
        const rating = Math.max(0, Math.min(5, Number(p.rating) || 0));
        const feeling = String(p.feeling || '');
        const recipeId = p.recipeId ? Number(p.recipeId) : null;
        const images = Array.isArray(p.images) ? JSON.stringify(p.images) : '[]';
        db.prepare('INSERT INTO meals (id,date,meal,type,recipe_id,name,cal,images,feeling,rating) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, date, '晚餐', 'cook', recipeId, dish, 0, images, feeling, rating);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, date, dish }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // ---- 通用增量 / 更新接口（支持任意模块，单向存库，无覆盖风险）----
  const INSERT_TABLES = new Set([
    'todos','recipes','meals','exercises','finances','price_items',
    'books','book_notes','english_words','projects','resources',
    'help_docs','wishlist','taskboard','diary','reward_log',
    'menus','shopping_items','pantry','entertainment'
  ]);
  const getCols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map(r => r.name);
  const normVal = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v); // 数组/对象存 JSON 文本
    return v;
  };

  // 通用增量：往指定表 INSERT 一条（只动该表，不影响其他 12 张）
  if (req.method === 'POST' && url === '/api/insert') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { table, fields } = JSON.parse(body);
        if (!INSERT_TABLES.has(table)) throw new Error('不允许的表: ' + table);
        if (!fields || typeof fields !== 'object') throw new Error('fields 必须是对象');
        const cols = getCols(table).filter(c => c !== 'id'); // id 自增
        const keys = Object.keys(fields).filter(k => cols.includes(k));
        if (!keys.length) throw new Error('没有合法字段可写入');
        const id = Date.now();
        const colSql = 'id,' + keys.join(',');
        const ph = '?,' + keys.map(() => '?').join(',');
        const vals = [id, ...keys.map(k => normVal(fields[k]))];
        db.prepare('INSERT INTO ' + table + ' (' + colSql + ') VALUES (' + ph + ')').run(...vals);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, table }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 通用更新：按 id 改指定表一条
  if (req.method === 'POST' && url === '/api/update') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { table, id, fields } = JSON.parse(body);
        if (!INSERT_TABLES.has(table)) throw new Error('不允许的表: ' + table);
        if (id === undefined || id === null) throw new Error('id 必填');
        if (!fields || typeof fields !== 'object') throw new Error('fields 必须是对象');
        const cols = getCols(table).filter(c => c !== 'id');
        const keys = Object.keys(fields).filter(k => cols.includes(k));
        if (!keys.length) throw new Error('没有合法字段可更新');
        const setSql = keys.map(k => k + '=?').join(',');
        const vals = [...keys.map(k => normVal(fields[k])), id];
        db.prepare('UPDATE ' + table + ' SET ' + setSql + ' WHERE id=?').run(...vals);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, table }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 通用删除接口：按 id 删除白名单内表的某行（用于任务板删除任务等）
  if (req.method === 'POST' && url === '/api/delete') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { table, id } = JSON.parse(body);
        if (!INSERT_TABLES.has(table)) throw new Error('不允许的表: ' + table);
        if (id === undefined || id === null) throw new Error('id 必填');
        db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, table }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 任务板拖动排序：批量更新 grp + ord（落库顺序/分组），前端一次拖拽只发一次请求
  if (req.method === 'POST' && url === '/api/reorder-taskboard') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { updates } = JSON.parse(body);
        if (!Array.isArray(updates) || !updates.length) throw new Error('updates 必须是非空数组');
        const stmt = db.prepare('UPDATE taskboard SET grp=?, ord=? WHERE id=?');
        for (const r of updates) stmt.run(String(r.grp), parseInt(r.ord) || 0, r.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: updates.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 从 Obsidian 日记批量导入到 diary 表（按 date 去重，已存在则跳过）
  if (req.method === 'POST' && url === '/api/import-diary') {
    try {
      const diaryDir = path.join(VAULT, '日记/daily note');
      const files = listMdRecursive(diaryDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));
      const existing = new Set(db.prepare('SELECT date FROM diary').all().map(r => r.date));
      let inserted = 0;
      const insDiary = db.prepare('INSERT INTO diary (id,date,title,content,mood,created_at) VALUES (?,?,?,?,?,?)');
      for (const f of files) {
        const text = readMdSafe(f.path);
        const lines = text.split('\n');
        let date = '', title = '', mood = '';
        const body = [];
        let seenTitle = false;
        for (const line of lines) {
          const dM = line.match(/^date:\s*(.+)$/);
          if (dM && !date) { date = dM[1].trim().slice(0, 10); continue; }
          const mooM = line.match(/^mood:\s*(.+)$/);
          if (mooM && !mood) { mood = mooM[1].trim(); continue; }
          const tM = line.match(/^#\s+(.+)$/);
          if (tM && !seenTitle) { title = tM[1].trim(); seenTitle = true; continue; }
          if (seenTitle) body.push(line);
        }
        if (!date) { const fm2 = f.name.match(/^(\d{4}-\d{2}-\d{2})/); if (fm2) date = fm2[1]; }
        if (!date || existing.has(date)) continue;
        const content = body.join('\n').trim();
        insDiary.run(Date.now() + inserted, date, title, content, mood, new Date().toISOString());
        inserted++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, inserted }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // ---- 从 Obsidian 娱乐目录增量同步到 entertainment 表 ----
  function parseEntertainment() {
    const entDir = path.join(VAULT, '娱乐');
    const files = listMdRecursive(entDir).filter(f => {
      const base = path.basename(f.name).toLowerCase();
      if (base.includes('readme')) return false;        // 汇总清单排除
      if (base === '音乐.md') return false;             // 根目录音乐汇总排除
      const rel = f.path.replace(/\\/g, '/');
      if (rel.includes('/娱乐/assets/')) return false;  // 图片资源目录
      return true;
    });
    // 已存在集合（按 type||title 去重，已存在跳过，不覆盖本地改动）
    const existing = new Set();
    db.prepare('SELECT type,title FROM entertainment').all().forEach(r => existing.add((r.type || '') + '||' + (r.title || '')));
    const insEnt = db.prepare('INSERT INTO entertainment (id,type,title,status,rating,tags,url,note,plot,quotes,review,cover,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const TYPE_MAP = { '电视剧': '电视剧', '电影': '电影', '动漫': '动漫', '漫画': '漫画', '书籍': '书籍', '游戏': '游戏', '音乐': '音乐' };
    let inserted = 0;
    for (const f of files) {
      const text = readMdSafe(f.path);
      if (!text.trim()) continue;
      const { fm, body } = parseFrontmatter(text);
        const dirName = path.basename(path.dirname(f.path));
        const segs = f.path.replace(/\\/g, '/').split('/');
        const entIdx = segs.lastIndexOf('娱乐');
        const topType = (entIdx >= 0 && segs[entIdx + 1]) ? segs[entIdx + 1] : dirName;
        const type = TYPE_MAP[topType] || topType;
      const title = (fm.title || path.basename(f.name).replace(/\.md$/, '')).trim();
      if (!title) continue;
      const key = type + '||' + title;
      if (existing.has(key)) continue;
      // 状态
      let status = '';
      const stM = body.match(/状态[：:]\s*\**\s*([未看想追在看已看看完]+)\s*\*/);
      if (stM) {
        const s = stM[1].trim();
        if (s === '已看' || s === '看完') status = '看完';
        else if (s === '在看') status = '在看';
        else if (s === '想看' || s === '想追') status = '想追';
        else if (s === '未看') status = '未看';
      }
      // 豆瓣评分
      let rating = 0;
      const rtM = body.match(/豆瓣[：:]\s*\**\s*\[?([\d.]+)\]?/);
      if (rtM) rating = parseFloat(rtM[1]) || 0;
      // 标签（#分类/标签#）
      const tagM = body.match(/标签[：:]\s*#([^#\n]+)#/);
      let tags = [];
      if (tagM) tags = tagM[1].split('/').map(t => t.trim()).filter(Boolean);
      // 资源链接
      const urlM = body.match(/资源[：:]\s*\[[^\]]*\]\(([^)]+)\)/);
      const url = urlM ? urlM[1] : '';
      // 封面（Obsidian ![[xxx.jpg]]）→ 复制到 uploads/ent，转成可访问 URL
      let cover = '';
      const coverM = body.match(/!\[\[([^\]]+\.(?:jpe?g|png|gif|webp))\]\]/i);
      if (coverM) {
        const fname = coverM[1];
        const candidates = [path.join(VAULT, '娱乐/assets', fname), path.join(path.dirname(f.path), fname)];
        const src = candidates.find(p => existsSync(p));
        if (src) {
          try {
            const dir = path.join(__dirname, 'uploads/ent');
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const safe = fname.replace(/[^a-zA-Z0-9._-]/g, '_');
            const dst = path.join(dir, safe);
            if (!existsSync(dst)) copyFileSync(src, dst);
            cover = '/uploads/ent/' + safe;
          } catch (e) { /* 封面复制失败不阻断 */ }
        }
      }
      // 分段提取
      const sectionOf = (name) => {
        const m = body.match(new RegExp('##\\s*\\*?\\*?' + name + '\\*?\\*?\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)', 'i'));
        return m ? m[1].trim().replace(/!\[\[.*?\]\]/g, '').slice(0, 2000) : '';
      };
      const plot = sectionOf('剧情简介');
      const quotes = sectionOf('台词记录');
      const review = sectionOf('观后感') || sectionOf('感想') || sectionOf('我的评价');
      // 无剧情简介的（多为游戏攻略/wiki）：把正文摘要存 note
      let note = '';
      if (!plot) {
        note = stripObsidian(body).replace(/^#.*$/gm, '').replace(/!\[\[.*?\]\]/g, '').trim().slice(0, 1500);
      }
      insEnt.run(Date.now() + inserted, type, title, status, rating, JSON.stringify(tags), url, note, plot, quotes, review, cover, new Date().toISOString());
      inserted++;
    }
    return inserted;
  }

  // 娱乐中心：从 Obsidian 增量同步（按 type+title 去重，已存在跳过）
  if (req.method === 'POST' && url === '/api/sync-entertainment') {
    try {
      const inserted = parseEntertainment();
      const total = db.prepare('SELECT COUNT(*) AS c FROM entertainment').get().c;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, inserted, total }));
    } catch (e) {
      console.error('SYNC-ENT ERROR:', e && e.stack ? e.stack : e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 玩家数值奖励：按增量累加 willpower/starwish/contract/level（delta 可正可负，不低于0）
  const REWARD_FIELDS = new Set(['willpower', 'starwish', 'contract', 'level']);
  if (req.method === 'POST' && url === '/api/reward') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        const cur = db.prepare('SELECT willpower,starwish,contract,level FROM player_stats WHERE id=1').get();
        if (!cur) throw new Error('player_stats 未初始化');
        const prev = { willpower: Number(cur.willpower) || 0, starwish: Number(cur.starwish) || 0, contract: Number(cur.contract) || 0, level: Number(cur.level) || 1 };
        const next = { ...prev };
        for (const f of REWARD_FIELDS) {
          if (typeof p[f] === 'number') {
            next[f] = Math.max(0, (next[f] || 0) + p[f]);
          }
        }
        db.prepare('UPDATE player_stats SET willpower=?,starwish=?,contract=?,level=? WHERE id=1')
          .run(next.willpower, next.starwish, next.contract, next.level);
        // 写流水账：仅在有数值变动时记录
        const dw = next.willpower - prev.willpower;
        const dsw = next.starwish - prev.starwish;
        if (dw !== 0 || dsw !== 0) {
          try {
            db.prepare('INSERT INTO reward_log (ts,source,text,dw,dsw,bw,bsw) VALUES (?,?,?,?,?,?,?)')
              .run(new Date().toISOString(), p.source || '其他', p.text || '', dw, dsw, next.willpower, next.starwish);
          } catch (le) { /* 流水写入失败不影响主流程 */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, player: next }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // 任务板刷新：日级任务跨天、周级任务跨周时自动取消勾选（重置为未完成，不扣回愿力点）
  if (req.method === 'POST' && url === '/api/taskboard-tick') {
    try {
      const pad = n => String(n).padStart(2, '0');
      const todayUTC = new Date().toISOString().slice(0, 10);
      const mondayOf = (ds) => { const d = new Date(ds + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
      const weekStart = mondayOf(todayUTC);
      const rows = db.prepare('SELECT id,grp,done,done_at,points FROM taskboard WHERE done=1').all();
      let resetCount = 0;
      const upd = db.prepare('UPDATE taskboard SET done=0, done_at=NULL WHERE id=?');
      for (const r of rows) {
        const grp = r.grp || '';
        if (!r.done_at) { // 旧数据无完成时间：初始化为今天，本周内不刷新
          db.prepare('UPDATE taskboard SET done_at=? WHERE id=?').run(todayUTC, r.id);
          continue;
        }
        let reset = false;
        if (grp.startsWith('日级')) reset = r.done_at.slice(0, 10) !== todayUTC;
        else if (grp.startsWith('周级')) reset = mondayOf(r.done_at.slice(0, 10)) !== weekStart;
        // 每日/每周重置：仅把任务打回未完成，不扣回愿力点（愿力点是完成任务赚到的，永久保留）
        if (reset) { upd.run(r.id); resetCount++; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, resetCount, willpowerDelta: 0, player: null }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 图片上传（前端把图片转 base64 传 JSON，后端写本地 uploads/，返回可访问 URL）
  if (req.method === 'POST' && url === '/api/upload') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        if (!name || !data) throw new Error('missing name/data');
        const dir = path.join(__dirname, 'uploads');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
        const buf = Buffer.from(String(data), 'base64');
        writeFileSync(path.join(dir, safe), buf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: '/uploads/' + safe }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // static file serving
  let p = url === '/' ? '/index.html' : url;
  const fp = path.join(__dirname, p);
  if (!fp.startsWith(__dirname) || !existsSync(fp)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(fp);
  try {
    const content = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT, () => {
  console.log(`LifeOS server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
