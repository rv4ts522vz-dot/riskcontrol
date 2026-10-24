require("dotenv").config();
const { Pool } = require("pg");

// Облачные базы (Render, Neon, Supabase) требуют SSL, локальная — нет.
// Для локальной базы поставь в .env: PGSSL=disable
const useSsl = process.env.DATABASE_URL && process.env.PGSSL !== "disable";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10
});

// Единое правило уровня риска — используется и в SQL, и в JS
const RISK_LEVEL_SQL = (scoreExpr) => `
  CASE
    WHEN ${scoreExpr} IS NULL THEN 'Нет оценки'
    WHEN ${scoreExpr} >= 70 THEN 'Высокий риск'
    WHEN ${scoreExpr} >= 40 THEN 'Средний риск'
    ELSE 'Низкий риск'
  END`;


// Схема базы. Создаётся автоматически при запуске сервера или генератора,
// поэтому на пустой базе ничего вручную запускать не нужно.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS employees (
  employee_id SERIAL PRIMARY KEY,
  full_name VARCHAR(200) NOT NULL,
  department VARCHAR(150),
  role_name VARCHAR(100),
  email VARCHAR(255) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id SERIAL PRIMARY KEY,
  supplier_name VARCHAR(255) NOT NULL,
  tax_id VARCHAR(50) UNIQUE NOT NULL,
  is_new BOOLEAN NOT NULL DEFAULT TRUE,
  verification_status VARCHAR(50) NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS contracts (
  contract_id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(supplier_id),
  contract_number VARCHAR(100) UNIQUE NOT NULL,
  contract_date DATE,
  contract_amount NUMERIC(14,2),
  contract_status VARCHAR(50) DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS purchases (
  purchase_id SERIAL PRIMARY KEY,
  contract_id INTEGER REFERENCES contracts(contract_id),
  purchase_date DATE,
  category VARCHAR(100),
  description TEXT,
  amount NUMERIC(14,2),
  delivery_confirmed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS payments (
  payment_id SERIAL PRIMARY KEY,
  purchase_id INTEGER REFERENCES purchases(purchase_id),
  payment_date DATE,
  amount NUMERIC(14,2),
  payment_status VARCHAR(50)
);
CREATE TABLE IF NOT EXISTS incidents (
  incident_id SERIAL PRIMARY KEY,
  reporter_id INTEGER REFERENCES employees(employee_id),
  supplier_id INTEGER REFERENCES suppliers(supplier_id),
  purchase_id INTEGER REFERENCES purchases(purchase_id),
  incident_type VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(14,2) DEFAULT 0,
  priority VARCHAR(20) NOT NULL DEFAULT 'medium',
  status VARCHAR(30) NOT NULL DEFAULT 'new',
  assigned_department VARCHAR(150),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  assessment_id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(incident_id),
  score INTEGER NOT NULL DEFAULT 0,
  reasons TEXT,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS incident_actions (
  action_id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(incident_id),
  employee_id INTEGER REFERENCES employees(employee_id),
  action_description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_supplier ON incidents(supplier_id);
`;

async function ensureSchema() {
  await pool.query(SCHEMA_SQL);
}

/*
  Главная идея для больших данных:
  вместо того чтобы на каждый заход на сайт пересчитывать 2 млн строк,
  мы один раз сворачиваем их в «куб» — материализованное представление
  с группировкой по месяцу, категории, приоритету, статусу и уровню риска.
  В кубе несколько тысяч строк, и любой график по нему считается за миллисекунды.
*/
const ANALYTICS_SQL = `
CREATE INDEX IF NOT EXISTS idx_risk_assessments_incident
  ON risk_assessments (incident_id, assessed_at DESC);
-- Индексы по полям с 4–6 значениями на 2 млн строк бесполезны: аналитику
-- считает куб, а реестр быстрее идёт по первичному ключу. Они только занимают место.
DROP INDEX IF EXISTS idx_incidents_status;
DROP INDEX IF EXISTS idx_incidents_priority;
DROP INDEX IF EXISTS idx_incidents_type;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_incident_cube AS
WITH latest AS (
  SELECT DISTINCT ON (incident_id) incident_id, score
  FROM risk_assessments
  ORDER BY incident_id, assessed_at DESC
)
SELECT
  date_trunc('month', i.created_at)::date AS month,
  i.incident_type,
  i.priority,
  i.status,
  ${RISK_LEVEL_SQL("l.score")} AS risk_level,
  COUNT(*)::bigint                    AS incident_count,
  COALESCE(SUM(i.amount), 0)::numeric AS total_amount,
  COALESCE(SUM(l.score), 0)::bigint   AS score_sum,
  COUNT(l.score)::bigint              AS scored_count
FROM incidents i
LEFT JOIN latest l ON l.incident_id = i.incident_id
GROUP BY 1, 2, 3, 4, 5;

CREATE UNIQUE INDEX IF NOT EXISTS mv_incident_cube_key
  ON mv_incident_cube (month, incident_type, priority, status, risk_level);
`;

async function ensureAnalytics() {
  await ensureSchema();
  await pool.query(ANALYTICS_SQL);
}

let refreshing = null;
let lastRefreshAt = null;

// CONCURRENTLY — сайт продолжает читать старые данные, пока идёт пересчёт
async function refreshAnalytics() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = 0");
      await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_incident_cube");
    } finally {
      client.release();
    }
    lastRefreshAt = new Date();
    console.log(`Аналитика пересчитана за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

module.exports = {
  pool,
  RISK_LEVEL_SQL,
  ensureSchema,
  ensureAnalytics,
  refreshAnalytics,
  getLastRefreshAt: () => lastRefreshAt,
  isRefreshing: () => Boolean(refreshing)
};
