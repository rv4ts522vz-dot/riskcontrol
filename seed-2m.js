/*
  Генерация большой базы RiskControl прямо внутри PostgreSQL.
  Данные создаются функцией generate_series на стороне сервера БД,
  поэтому не нужны CSV-файлы и ничего не гоняется по сети.

  Запуск:
    node seed-2m.js --reset                  (2 000 000 инцидентов)
    node seed-2m.js --reset --count=500000   (другой объём)

  --reset очищает ВСЕ таблицы RiskControl перед генерацией.
*/
const { pool, ensureSchema, ensureAnalytics, refreshAnalytics } = require("./db");

const args = process.argv.slice(2);
const RESET = args.includes("--reset");
const COUNT = Number((args.find(a => a.startsWith("--count=")) || "").split("=")[1]) || 2_000_000;
const BATCH = 200_000;

const EMPLOYEES = 500;
const SUPPLIERS = 5_000;
const CONTRACTS = 50_000;
const PURCHASES = 300_000;
const ACTIONS = Math.round(COUNT * 0.15);

const TABLES = [
  "incident_actions", "risk_assessments", "incidents",
  "payments", "purchases", "contracts", "suppliers", "employees"
];

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;

async function step(client, title, sql, params = []) {
  process.stdout.write(`${title}... `);
  const r = await client.query(sql, params);
  console.log(`${r.rowCount ?? ""} (${elapsed()})`);
}

async function main() {
  await ensureSchema(); // на пустой базе сначала создаём таблицы
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");

    const { rows } = await client.query(
      `SELECT ${TABLES.map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ")}`
    );
    const nonEmpty = Object.entries(rows[0]).filter(([, n]) => Number(n) > 0);
    if (nonEmpty.length && !RESET) {
      throw new Error(
        `В базе уже есть данные (${nonEmpty.map(([t, n]) => `${t}: ${n}`).join(", ")}).\n` +
        `Запусти с флагом --reset, чтобы очистить таблицы и сгенерировать заново.`
      );
    }

    await client.query("DROP MATERIALIZED VIEW IF EXISTS mv_incident_cube");
    if (RESET) {
      await step(client, "Очистка таблиц",
        `TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    }

    console.log(`\nГенерация: ${COUNT.toLocaleString("ru-RU")} инцидентов\n`);

    await step(client, `Сотрудники (${EMPLOYEES})`, `
      INSERT INTO employees (full_name, department, role_name, email)
      SELECT
        (ARRAY['Иванов','Петрова','Сидоров','Кузнецова','Смирнов','Попова','Волков','Соколова','Морозов','Лебедева'])[1 + floor(random()*10)::int]
          || ' ' || (ARRAY['А.','Б.','В.','Г.','Д.','Е.','И.','К.','М.','Н.'])[1 + floor(random()*10)::int]
          || (ARRAY['А.','В.','С.','П.','О.'])[1 + floor(random()*5)::int],
        (ARRAY['Закупки','Финансы','Безопасность','Логистика','Юридический отдел','Транспортный цех'])[1 + floor(random()*6)::int],
        (ARRAY['Специалист','Ведущий специалист','Руководитель','Аналитик'])[1 + floor(random()*4)::int],
        'employee' || g || '@riskcontrol.local'
      FROM generate_series(1, ${EMPLOYEES}) g`);

    await step(client, `Поставщики (${SUPPLIERS})`, `
      INSERT INTO suppliers (supplier_name, tax_id, is_new, verification_status)
      SELECT
        (ARRAY['ООО','АО','ИП','ПАО'])[1 + floor(random()*4)::int] || ' «'
          || (ARRAY['Север','Вектор','Альфа','Транс','Ресурс','Строй','Нефть','Снаб','Логик','Техно'])[1 + floor(random()*10)::int]
          || (ARRAY['Пром','Сервис','Групп','Трейд','Ойл','Маш'])[1 + floor(random()*6)::int] || '-' || g || '»',
        lpad(g::text, 10, '0'),
        random() < 0.2,
        (ARRAY['verified','verified','verified','pending','rejected'])[1 + floor(random()*5)::int]
      FROM generate_series(1, ${SUPPLIERS}) g`);

    await step(client, `Договоры (${CONTRACTS})`, `
      INSERT INTO contracts (supplier_id, contract_number, contract_date, contract_amount, contract_status)
      SELECT
        1 + floor(random()*${SUPPLIERS})::int,
        'Д-' || lpad(g::text, 6, '0'),
        (CURRENT_DATE - (random()*1095)::int),
        round((50000 + random()^2 * 20000000)::numeric, 2),
        (ARRAY['active','active','active','closed','terminated'])[1 + floor(random()*5)::int]
      FROM generate_series(1, ${CONTRACTS}) g`);

    await step(client, `Закупки (${PURCHASES})`, `
      INSERT INTO purchases (contract_id, purchase_date, category, description, amount, delivery_confirmed)
      SELECT
        1 + floor(random()*${CONTRACTS})::int,
        (CURRENT_DATE - (random()*730)::int),
        (ARRAY['ГСМ','Запчасти','Спецтехника','Услуги','Канцтовары','Стройматериалы'])[1 + floor(random()*6)::int],
        'Закупка №' || g,
        round((1000 + random()^3 * 3000000)::numeric, 2),
        random() < 0.85
      FROM generate_series(1, ${PURCHASES}) g`);

    await step(client, `Платежи (${PURCHASES})`, `
      INSERT INTO payments (purchase_id, payment_date, amount, payment_status)
      SELECT p.purchase_id,
             p.purchase_date + (random()*30)::int,
             p.amount,
             (ARRAY['paid','paid','paid','pending','failed'])[1 + floor(random()*5)::int]
      FROM purchases p`);

    // ---------- 2 000 000 инцидентов, пачками по 200 тыс. ----------
    for (let from = 1; from <= COUNT; from += BATCH) {
      const to = Math.min(from + BATCH - 1, COUNT);
      await step(client, `Инциденты ${from.toLocaleString("ru-RU")}–${to.toLocaleString("ru-RU")}`, `
        INSERT INTO incidents (reporter_id, supplier_id, purchase_id, incident_type, description,
                               amount, priority, status, assigned_department, created_at)
        SELECT
          1 + floor(r.r1 * ${EMPLOYEES})::int,
          1 + floor(r.r2 * ${SUPPLIERS})::int,
          1 + floor(r.r3 * ${PURCHASES})::int,
          t.incident_type,
          CASE t.incident_type
                 WHEN 'ГСМ'       THEN (ARRAY['списание топлива сверх нормы','расхождение по топливным картам','заправка вне маршрута'])[1 + floor(random()*3)::int]
                 WHEN 'платёж'    THEN (ARRAY['перечисление без закрывающих документов','дублирование оплаты','оплата по изменённым реквизитам'])[1 + floor(random()*3)::int]
                 WHEN 'поставщик' THEN (ARRAY['поставщик без истории работы','аффилированность с сотрудником','недостоверные данные контрагента'])[1 + floor(random()*3)::int]
                 WHEN 'договор'   THEN (ARRAY['изменение суммы после подписания','дробление закупки','договор без конкурса'])[1 + floor(random()*3)::int]
                 WHEN 'техника'   THEN (ARRAY['простой техники при оплате работ','ремонт без акта дефектовки','несоответствие пробега'])[1 + floor(random()*3)::int]
                 ELSE                  (ARRAY['нарушение регламента','сигнал на горячую линию','иное нарушение'])[1 + floor(random()*3)::int]
               END,
          round((r.r4 ^ 3 * 3000000)::numeric, 2),
          CASE WHEN r.r5 < 0.08 THEN 'critical' WHEN r.r5 < 0.25 THEN 'high'
               WHEN r.r5 < 0.65 THEN 'medium'   ELSE 'low' END,
          CASE WHEN r.r6 < 0.12 THEN 'new'      WHEN r.r6 < 0.25 THEN 'assigned'
               WHEN r.r6 < 0.40 THEN 'in_review' WHEN r.r6 < 0.78 THEN 'resolved'
               WHEN r.r6 < 0.94 THEN 'closed'   ELSE 'rejected' END,
          CASE t.incident_type
            WHEN 'ГСМ' THEN 'Транспортный цех' WHEN 'платёж' THEN 'Финансы'
            WHEN 'поставщик' THEN 'Безопасность' WHEN 'договор' THEN 'Юридический отдел'
            WHEN 'техника' THEN 'Логистика' ELSE 'Безопасность' END,
          -- sqrt смещает даты к настоящему: число сигналов растёт со временем
          NOW() - (1 - sqrt(r.r7)) * INTERVAL '730 days'
        FROM generate_series($1::int, $2::int) g
        CROSS JOIN LATERAL (
          SELECT random() + g*0 AS r1, random() AS r2, random() AS r3, random() AS r4,
                 random() AS r5, random() AS r6, random() AS r7, random() AS r8
        ) r
        CROSS JOIN LATERAL (
          SELECT (ARRAY['ГСМ','платёж','поставщик','договор','техника','другое'])
                 [CASE WHEN r.r8 < 0.25 THEN 1 WHEN r.r8 < 0.45 THEN 2 WHEN r.r8 < 0.60 THEN 3
                       WHEN r.r8 < 0.75 THEN 4 WHEN r.r8 < 0.90 THEN 5 ELSE 6 END] AS incident_type
        ) t`, [from, to]);
    }

    // ---------- оценка риска для каждого инцидента ----------
    for (let from = 1; from <= COUNT; from += BATCH) {
      const to = Math.min(from + BATCH - 1, COUNT);
      await step(client, `Оценки риска ${from.toLocaleString("ru-RU")}–${to.toLocaleString("ru-RU")}`, `
        INSERT INTO risk_assessments (incident_id, score, reasons, assessed_at)
        SELECT i.incident_id,
               LEAST(100, s.base + s.amount_pts + s.priority_pts + floor(random()*16)::int),
               NULLIF(concat_ws('; ',
                 CASE WHEN i.amount >= 1000000 THEN 'крупная сумма' END,
                 CASE WHEN i.priority IN ('critical','high') THEN 'приоритет' END), ''),
               i.created_at + random() * INTERVAL '2 days'
        FROM incidents i
        CROSS JOIN LATERAL (
          SELECT
            CASE i.incident_type WHEN 'платёж' THEN 30 WHEN 'ГСМ' THEN 25 WHEN 'поставщик' THEN 20
                                 WHEN 'договор' THEN 20 WHEN 'техника' THEN 15 ELSE 10 END AS base,
            LEAST(35, floor(i.amount / 85000))::int AS amount_pts,
            CASE i.priority WHEN 'critical' THEN 25 WHEN 'high' THEN 15 WHEN 'medium' THEN 8 ELSE 0 END AS priority_pts
        ) s
        WHERE i.incident_id BETWEEN $1 AND $2`, [from, to]);
    }

    await step(client, `Действия по инцидентам (${ACTIONS})`, `
      INSERT INTO incident_actions (incident_id, employee_id, action_description, created_at)
      SELECT 1 + floor(random()*${COUNT})::int,
             1 + floor(random()*${EMPLOYEES})::int,
             (ARRAY['Запрошены документы','Назначена проверка','Проведена беседа','Передано в СБ','Проверка завершена'])[1 + floor(random()*5)::int],
             NOW() - random() * INTERVAL '700 days'
      FROM generate_series(1, ${ACTIONS}) g`);

    client.release();

    process.stdout.write("Индексы и материализованное представление... ");
    await ensureAnalytics();
    console.log(`готово (${elapsed()})`);

    await pool.query("ANALYZE");
    await refreshAnalytics();

    const check = await pool.query(`
      SELECT (SELECT COUNT(*) FROM incidents)        AS incidents,
             (SELECT COUNT(*) FROM risk_assessments) AS assessments,
             (SELECT COUNT(*) FROM mv_incident_cube) AS cube_rows,
             pg_size_pretty(pg_database_size(current_database())) AS db_size`);
    console.table(check.rows);
    console.log(`Всё готово за ${elapsed()}`);
  } catch (e) {
    try { client.release(); } catch {}
    throw e;
  }
}

main()
  .catch(e => { console.error("\nОШИБКА:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
