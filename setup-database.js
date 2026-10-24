// Создание таблиц вручную (необязательно: сервер и генератор создают их сами)
const { pool, ensureSchema } = require("./db");

ensureSchema()
  .then(async () => {
    const r = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    console.log("Таблицы RiskControl готовы:");
    console.table(r.rows);
  })
  .catch(e => { console.error("Ошибка создания таблиц:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
