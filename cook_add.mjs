// 烟火食记 - 记一道菜（命令行快捷入口）
// 由 AI 解析自然语言后调用，或手动传参使用。
// 用法: node cook_add.mjs --dish 菜名 --feeling "感受" --rating 4 --recipeId 3 [--date 2026-07-30] [--images /uploads/a.png,/uploads/b.png]
import { request } from 'node:http';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++; }
    else opt[k] = true;
  }
}

const dish = String(opt.dish || '').trim();
if (!dish) {
  console.error('用法: node cook_add.mjs --dish 菜名 --feeling "感受" --rating 4 --recipeId 3 [--date 2026-07-30] [--images /uploads/a.png,/uploads/b.png]');
  process.exit(1);
}

const payload = {
  dish,
  feeling: String(opt.feeling || ''),
  rating: opt.rating ? Number(opt.rating) : 0,
  recipeId: opt.recipeId ? Number(opt.recipeId) : null,
  date: opt.date || new Date().toISOString().slice(0, 10),
  images: opt.images ? String(opt.images).split(',').map(s => s.trim()).filter(Boolean) : []
};

const body = JSON.stringify(payload);
const req = request(
  {
    host: 'localhost', port: 3000, path: '/api/cook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  },
  res => {
    let d = '';
    res.on('data', c => (d += c));
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.ok) console.log('✅ 已存入烟火食记: ' + r.dish + ' (' + r.date + ', id=' + r.id + ')');
        else { console.error('❌ 失败: ' + r.error); process.exit(1); }
      } catch (e) {
        console.error('❌ 返回解析失败: ' + d);
        process.exit(1);
      }
    });
  }
);
req.on('error', e => {
  console.error('❌ 连不上 localhost:3000，确认 server 是否已启动(start.bat 或开机自启): ' + e.message);
  process.exit(1);
});
req.write(body);
req.end();
