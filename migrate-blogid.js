import "dotenv/config";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const databaseId =
  process.env.MIGRATE_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID_BLOGSCARP ||
  process.env.NOTION_DATABASE_ID_BLOGSCARPTEMP;

if (!databaseId) {
  console.error(
    "❌ 마이그레이션 대상 DB ID가 없습니다. MIGRATE_DATABASE_ID 또는 관련 NOTION_DATABASE_ID_* 환경변수를 설정하세요."
  );
  process.exit(1);
}

const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || "0", 10) || 0;

const FORMULA_PROP_NAME = "BlogID";
const TEXT_PROP_NAME = "ID";
const YEAR_PROP_NAME = "연도";
const YEARMONTH_PROP_NAME = "연월";
const QUARTER_PROP_NAME = "분기";
const DATE_PROP_NAME = "원본 날짜";

function extractFormulaValue(formulaProp) {
  if (!formulaProp || formulaProp.type !== "formula") return null;
  const f = formulaProp.formula;
  if (!f) return null;
  if (f.type === "string") return f.string || null;
  if (f.type === "number" && f.number != null) return String(f.number);
  if (f.type === "boolean") return String(f.boolean);
  if (f.type === "date" && f.date?.start) return f.date.start;
  return null;
}

function extractYyYmQ(dateProp) {
  if (!dateProp || dateProp.type !== "date" || !dateProp.date?.start) {
    return { year: null, yearMonth: null, quarter: null };
  }
  const raw = dateProp.date.start;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    return { year: null, yearMonth: null, quarter: null };
  }
  const year = String(d.getFullYear());
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const yearMonth = `${year}-${mm}`;
  let q;
  if (month <= 3) q = "Q1";
  else if (month <= 6) q = "Q2";
  else if (month <= 9) q = "Q3";
  else q = "Q4";
  const quarter = `${year}-${q}`;
  return { year, yearMonth, quarter };
}

function isRetryableError(err) {
  const code = err.code || err.status || err.type || "";
  const msg = (err.message || "").toString();
  return (
    code === "notionhq_client_request_timeout" ||
    code === "rate_limited" ||
    code === "service_unavailable" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === 503 ||
    msg.includes("socket hang up") ||
    msg.includes("ECONNRESET") ||
    msg.includes("timeout")
  );
}

async function safeQuery(params, label = "databases.query", retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await notion.databases.query(params);
    } catch (err) {
      const code = err.code || err.status || "";
      const msg = err.message || String(err);
      console.warn(`⚠️ ${label} 실패 (${attempt}/${retries}) : [${code}] ${msg}`);
      if (!isRetryableError(err) || attempt === retries) {
        console.error(`❌ ${label} 재시도 포기: [${code}] ${msg}`);
        return null;
      }
      const delayMs = 1000 * attempt;
      console.log(`⏳ ${delayMs / 1000}s 대기 후 ${label} 재시도...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function safeUpdatePage(pageId, properties, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await notion.pages.update({
        page_id: pageId,
        properties,
      });
      return true;
    } catch (err) {
      const code = err.code || err.status || err.type || "";
      const msg = err.message || String(err);
      console.warn(
        `⚠️ Notion 업데이트 실패 (${attempt}/${retries}) [${pageId}] : [${code}] ${msg}`
      );
      if (!isRetryableError(err) || attempt === retries) {
        console.error(`❌ 업데이트 포기: ${pageId}`);
        return false;
      }
      const delayMs = 1000 * attempt;
      console.log(`⏳ ${delayMs / 1000}s 대기 후 update 재시도...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function migrate() {
  console.log(
    `🚀 BlogID → ID + 연도/연월/분기 마이그레이션 시작` +
      (MIGRATE_LIMIT
        ? ` (이번 실행 최대 ${MIGRATE_LIMIT}건 업데이트)`
        : " (업데이트 건수 제한 없음)")
  );

  let cursor = undefined;
  let scanned = 0;
  let updatedPages = 0;

  console.log("🔍 첫 batch 조회 시작 (databases.query)...");

  mainLoop: while (true) {
    const resp = await safeQuery(
      {
        database_id: databaseId,
        start_cursor: cursor,
        page_size: 50,
      },
      "databases.query"
    );

    if (!resp) {
      console.error("⏹ safeQuery에서 null 반환 → 종료");
      break;
    }

    console.log(`📥 batch 수신: ${resp.results.length}개`);

    if (resp.results.length === 0 && !resp.has_more) break;

    for (const page of resp.results) {
      scanned++;
      const props = page.properties;
      const updates = {};

      const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
      const textProp = props[TEXT_PROP_NAME];
      const hasText =
        textProp?.type === "rich_text" && textProp.rich_text.length > 0;

      if (formulaValue && !hasText) {
        updates[TEXT_PROP_NAME] = {
          rich_text: [{ text: { content: formulaValue } }],
        };
      }

      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);
      if (year && props[YEAR_PROP_NAME]?.rich_text?.length === 0) {
        updates[YEAR_PROP_NAME] = { rich_text: [{ text: { content: year } }] };
      }
      if (yearMonth && props[YEARMONTH_PROP_NAME]?.rich_text?.length === 0) {
        updates[YEARMONTH_PROP_NAME] = {
          rich_text: [{ text: { content: yearMonth } }],
        };
      }
      if (quarter && props[QUARTER_PROP_NAME]?.rich_text?.length === 0) {
        updates[QUARTER_PROP_NAME] = {
          rich_text: [{ text: { content: quarter } }],
        };
      }

      if (Object.keys(updates).length === 0) continue;
      if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) break mainLoop;

      const ok = await safeUpdatePage(page.id, updates);
      if (ok) updatedPages++;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(`🎉 완료: 스캔 ${scanned} / 업데이트 ${updatedPages}`);
}

migrate().catch((err) => {
  console.error("❌ 마이그레이션 중 오류:", err);
  process.exit(1);
});
