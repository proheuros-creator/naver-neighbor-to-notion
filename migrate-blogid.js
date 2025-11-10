import "dotenv/config";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ✅ 우선순위로 마이그레이션 대상 DB 선택
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

// 이번 실행에서 실제 업데이트 최대 건수 (0이면 제한 없음)
const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || "0", 10) || 0;

// 노션 속성 이름들
const FORMULA_PROP_NAME = "BlogID";
const TEXT_PROP_NAME = "ID";
const YEAR_PROP_NAME = "연도";
const YEARMONTH_PROP_NAME = "연월";
const QUARTER_PROP_NAME = "분기";
const DATE_PROP_NAME = "원본 날짜";

/**
 * BlogID formula 값 추출
 */
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

/**
 * 원본 날짜에서 연/연월/분기 계산
 */
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
  else if (month <=
