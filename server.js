const path = require("path");
const express = require("express");
const {
  pool, RISK_LEVEL_SQL, ensureAnalytics, refreshAnalytics,
  getLastRefreshAt, isRefreshing
} = require("./db");

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

const TYPES = ["ГСМ", "платёж", "поставщик", "договор", "техника", "другое"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const STATUSES = ["new", "assigned", "in_review", "resolved", "closed", "rejected"];
const DEPARTMENTS = {
  "ГСМ": "Транспортный цех", "платёж": "Финансы", "поставщик": "Безопасность",
  "договор": "Юридический отдел", "техника": "Логистика", "другое": "Безопасность"
};
const ALARM_WORDS = ["срочно", "хищение", "откат", "взятк", "подлог", "мошен", "кража", "фиктив"];

// ---------- автоматическая оценка риска нового сигнала ----------
function assessRisk({ incident_type, amount, description, panic }) {
  const reasons = [];
  let score = { "платёж": 30, "ГСМ": 25, "поставщик": 20, "договор": 20, "техника": 15 }[incident_type] ?? 10;
  reasons.push(`Категория: ${incident_type}`);

  const amountPts = Math.min(35, Math.floor(amount / 85000));
  if (amountPts > 0) { score += amountPts; }
  if (amount >= 1_000_000) reasons.push("крупная сумма");

  const text = description.toLowerCase();
  const hits = ALARM_WORDS.filter(w => text.includes(w));
  if (hits.length) { score += Math.min(20, hits.length * 10); reasons.push("тревожные слова в описании"); }

  if (panic) { score += 25; reasons.push("тревожная кнопка"); }
  score = Math.max(0, Math.min(100, score));

  const priority = panic || score >= 80 ? "critical"
    : score >= 60 ? "high"
    : score >= 35 ? "medium" : "low";

  return { score, priority, reasons: reasons.join("; ") };
}

// После новых сигналов пересчитываем аналитику с небольшой задержкой,
// чтобы серия нажатий не запускала пересчёт много раз подряд
let refreshTimer = null;
function scheduleRefresh(delay = 3000) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAnalytics().catch(e => console.error("refresh:", e.message)), delay);
}

// ---------- API ----------
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

const recentIncidentsSql = `
  SELECT i.incident_id, i.incident_type, i.description, i.amount,
         i.priority, i.status, i.created_at, ra.score,
         ${RISK_LEVEL_SQL("ra.score")} AS risk_level
  FROM incidents i
  LEFT JOIN LATERAL (
    SELECT score FROM risk_assessments r
    WHERE r.incident_id = i.incident_id
    ORDER BY assessed_at DESC LIMIT 1
  ) ra ON true`;

app.get("/api/dashboard", async (req, res) => {
  try {
    const [summary, risk, priority, trend, category, recent, pending] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(incident_count), 0)                                        AS total_incidents,
               COALESCE(SUM(incident_count) FILTER (WHERE risk_level = 'Высокий риск'), 0) AS high_risk_incidents,
               COALESCE(SUM(incident_count) FILTER (WHERE status = 'new'), 0)           AS new_incidents,
               ROUND(SUM(score_sum)::numeric / NULLIF(SUM(scored_count), 0), 2)       AS average_score,
               COALESCE(SUM(total_amount), 0)                                          AS total_amount,
               COALESCE(SUM(scored_count), 0)                                          AS assessed_incidents,
               COALESCE(SUM(incident_count) FILTER (WHERE status = 'in_review'), 0)     AS in_review_incidents,
               COALESCE(SUM(incident_count) FILTER (WHERE status IN ('resolved','closed')), 0) AS resolved_incidents
        FROM mv_incident_cube`),
      pool.query(`
        SELECT risk_level, SUM(incident_count) AS incident_count
        FROM mv_incident_cube WHERE risk_level <> 'Нет оценки'
        GROUP BY risk_level
        ORDER BY array_position(ARRAY['Высокий риск','Средний риск','Низкий риск'], risk_level)`),
      pool.query(`
        SELECT priority, SUM(incident_count) AS incident_count
        FROM mv_incident_cube GROUP BY priority`),
      pool.query(`
        SELECT to_char(m.month, 'YYYY-MM-DD') AS month, COALESCE(SUM(c.incident_count), 0) AS incident_count
        FROM generate_series(date_trunc('month', NOW()) - INTERVAL '11 months',
                             date_trunc('month', NOW()), INTERVAL '1 month') AS m(month)
        LEFT JOIN mv_incident_cube c ON c.month = m.month::date
        GROUP BY m.month ORDER BY m.month`),
      pool.query(`
        SELECT incident_type, SUM(incident_count) AS incident_count, SUM(total_amount) AS total_amount,
               ROUND(SUM(score_sum)::numeric / NULLIF(SUM(scored_count), 0), 1) AS average_score
        FROM mv_incident_cube GROUP BY incident_type ORDER BY incident_count DESC`),
      pool.query(`${recentIncidentsSql} ORDER BY i.created_at DESC LIMIT 10`),
      // сигналы, поступившие после последнего пересчёта куба (быстро — по индексу created_at)
      getLastRefreshAt()
        ? pool.query(`SELECT COUNT(*) AS n FROM incidents WHERE created_at > $1`, [getLastRefreshAt()])
        : Promise.resolve({ rows: [{ n: 0 }] })
    ]);

    res.json({
      summary: summary.rows[0],
      riskDistribution: risk.rows,
      priorityDistribution: priority.rows,
      monthlyTrend: trend.rows,
      categoryDistribution: category.rows,
      recentIncidents: recent.rows,
      analytics: {
        refreshed_at: getLastRefreshAt(),
        refreshing: isRefreshing(),
        pending_incidents: Number(pending.rows[0].n)
      }
    });
  } catch (e) {
    console.error("dashboard:", e);
    res.status(500).json({ error: e.message });
  }
});

// Реестр всех инцидентов: фильтры + постраничный вывод по ключу (keyset).
// OFFSET на 2 млн строк тормозит, а "WHERE incident_id < курсор" работает мгновенно на любой странице.
app.get("/api/incidents", async (req, res) => {
  try {
    const type = TYPES.includes(req.query.type) ? req.query.type : null;
    const priority = PRIORITIES.includes(req.query.priority) ? req.query.priority : null;
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const before = Number.isInteger(+req.query.before) && +req.query.before > 0 ? +req.query.before : null;
    const limit = Math.min(50, Math.max(5, +req.query.limit || 20));

    const [rows, total] = await Promise.all([
      pool.query(`
        ${recentIncidentsSql}
        WHERE ($1::text IS NULL OR i.incident_type = $1)
          AND ($2::text IS NULL OR i.priority = $2)
          AND ($3::text IS NULL OR i.status = $3)
          AND ($4::int  IS NULL OR i.incident_id < $4)
        ORDER BY i.incident_id DESC
        LIMIT $5`, [type, priority, status, before, limit]),
      // общее число по фильтру берём из куба — без COUNT(*) по 2 млн строк
      pool.query(`
        SELECT COALESCE(SUM(incident_count), 0) AS total FROM mv_incident_cube
        WHERE ($1::text IS NULL OR incident_type = $1)
          AND ($2::text IS NULL OR priority = $2)
          AND ($3::text IS NULL OR status = $3)`, [type, priority, status])
    ]);

    const items = rows.rows;
    res.json({
      items,
      total: Number(total.rows[0].total),
      next_cursor: items.length === limit ? items[items.length - 1].incident_id : null
    });
  } catch (e) {
    console.error("incidents:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/incidents", async (req, res) => {
  const panic = req.body.panic === true;
  const incident_type = String(req.body.incident_type || "");
  let description = String(req.body.description || "").trim();
  const amount = Number(req.body.amount || 0);

  if (!TYPES.includes(incident_type)) {
    return res.status(400).json({ error: "Выбери категорию риска" });
  }
  if (panic && description.length < 10) {
    description = `ТРЕВОЖНЫЙ СИГНАЛ: ${incident_type}. Требуется срочная проверка.` +
      (description ? ` ${description}` : "");
  }
  if (description.length < 10 || description.length > 3000) {
    return res.status(400).json({ error: "Описание должно быть от 10 до 3000 символов" });
  }
  if (!Number.isFinite(amount) || amount < 0 || amount > 999_999_999_999) {
    return res.status(400).json({ error: "Некорректная сумма" });
  }

  const risk = assessRisk({ incident_type, amount, description, panic });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inc = await client.query(`
      INSERT INTO incidents (incident_type, description, amount, priority, status, assigned_department)
      VALUES ($1, $2, $3, $4, 'new', $5)
      RETURNING incident_id, incident_type, description, amount, priority, status, created_at`,
      [incident_type, description, amount, risk.priority, DEPARTMENTS[incident_type]]);
    await client.query(
      `INSERT INTO risk_assessments (incident_id, score, reasons) VALUES ($1, $2, $3)`,
      [inc.rows[0].incident_id, risk.score, risk.reasons]);
    await client.query("COMMIT");

    scheduleRefresh();
    const levelRow = await pool.query(`SELECT ${RISK_LEVEL_SQL("$1::int")} AS risk_level`, [risk.score]);
    res.status(201).json({
      incident: { ...inc.rows[0], score: risk.score, risk_level: levelRow.rows[0].risk_level, reasons: risk.reasons }
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("create incident:", e);
    res.status(500).json({ error: "Не удалось сохранить риск: " + e.message });
  } finally {
    client.release();
  }
});

// ручной пересчёт аналитики
app.post("/api/analytics/refresh", async (req, res) => {
  try {
    await refreshAnalytics();
    res.json({ refreshed_at: getLastRefreshAt() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

(async () => {
  await ensureAnalytics();          // создаст куб, если его ещё нет
  app.listen(PORT, () => console.log(`RiskControl: http://localhost:${PORT}`));
  refreshAnalytics().catch(e => console.error("refresh:", e.message));
  setInterval(() => refreshAnalytics().catch(() => {}), 10 * 60 * 1000);
})().catch(e => {
  console.error("Не удалось запустить сервер:", e.message);
  process.exit(1);
});
