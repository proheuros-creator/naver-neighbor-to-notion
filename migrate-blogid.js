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
const FORMULA_PROP_NAME = "BlogID";     // 기존 Formula 컬럼
const TEXT_PROP_NAME = "ID";            // 새 Text 컬럼 (BlogID 복사 대상)
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
  else if (month <= 9) q = "Q3";
  else q = "Q4";

  const quarter = `${year}-${q}`;

  return { year, yearMonth, quarter };
}

/**
 * 이 에러는 재시도 해볼 만한가?
 */
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

/**
 * 🔁 databases.query 재시도 래퍼
 *  - 실패 시 최대 retries번 재시도
 *  - 끝까지 안 되면 null 반환 (해당 chunk만 포기, 전체는 유지)
 */
async function safeQuery(params, label = "databases.query", retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await notion.databases.query(params);
    } catch (err) {
      const code = err.code || err.status || "";
      const msg = err.message || String(err);

      console.warn(`⚠️ ${label} 실패 (${attempt}/${retries}) : [${code}] ${msg}`);

      if (!isRetryableError(err) || attempt === retries) {
        console.error(
          `❌ ${label} 재시도 포기 (이 쿼리 batch는 건너뜁니다): [${code}] ${msg}`
        );
        return null;
      }

      const delayMs = 1000 * attempt; // 1s, 2s, 3s
      console.log(`⏳ ${delayMs / 1000}s 대기 후 ${label} 재시도...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

/**
 * 🔁 pages.update 재시도 래퍼
 *  - 성공: true
 *  - 최종 실패: false (그 페이지만 스킵)
 */
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
        console.error(
          `❌ 업데이트 포기: ${pageId} (이 페이지는 건너뜁니다)`
        );
        return false;
      }

      const delayMs = 1000 * attempt;
      console.log(`⏳ ${delayMs / 1000}s 대기 후 update 재시도...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/**
 * 🚀 메인 마이그레이션
 */
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
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;

  // 아직 마이그레이션 필요한 페이지만 조회
  const baseFilter = {
    or: [
      { property: TEXT_PROP_NAME, rich_text: { is_empty: true } },
      { property: YEAR_PROP_NAME, rich_text: { is_empty: true } },
      { property: YEARMONTH_PROP_NAME, rich_text: { is_empty: true } },
      { property: QUARTER_PROP_NAME, rich_text: { is_empty: true } },
    ],
  };

  mainLoop: while (true) {
    const resp = await safeQuery(
      {
        database_id: databaseId,
        start_cursor: cursor,
        page_size: 100,
        filter: baseFilter,
      },
      "databases.query"
    );

    // 쿼리를 끝내도 성공 못함 → 더 가도 의미 없으니 종료
    if (!resp) {
      console.error("⏹ 연속 쿼리 오류로 인해 마이그레이션을 종료합니다.");
      break;
    }

    if (resp.results.length === 0 && !resp.has_more) {
      break;
    }

    for (const page of resp.results) {
      scanned++;
      const props = page.properties;
      const updates = {};

      // 1) BlogID formula → ID text
      if (props[FORMULA_PROP_NAME] && props[TEXT_PROP_NAME]) {
        const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
        const textProp = props[TEXT_PROP_NAME];
        const hasText =
          textProp.type === "rich_text" &&
          textProp.rich_text.length > 0;

        if (formulaValue && !hasText) {
          updates[TEXT_PROP_NAME] = {
            rich_text: [{ text: { content: formulaValue } }],
          };
          updatedBlogId++;
        }
      }

      // 2) 원본 날짜 → 연도/연월/분기
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const p = props[YEAR_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[YEAR_PROP_NAME] = {
            rich_text: [{ text: { content: year } }],
          };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const p = props[YEARMONTH_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[YEARMONTH_PROP_NAME] = {
            rich_text: [{ text: { content: yearMonth } }],
          };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const p = props[QUARTER_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [{ text: { content: quarter } }],
          };
          updatedQuarter++;
        }
      }

      // 업데이트할 내용 없으면 skip
      if (Object.keys(updates).length === 0) continue;

      // MIGRATE_LIMIT 체크
      if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) {
        console.log(
          `⏹ MIGRATE_LIMIT(${MIGRATE_LIMIT}) 도달, 이번 실행 종료`
        );
        break mainLoop;
      }

      const ok = await safeUpdatePage(page.id, updates);
      await new Promise((r) => setTimeout(r, 50)); // 부하 완화

      if (ok) {
        updatedPages++;
      }

      if (scanned % 500 === 0) {
        console.log(
          `📊 스캔 ${scanned} / 업데이트 ${updatedPages} / ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
        );
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 스캔 ${scanned} / 업데이트 ${updatedPages} / ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
  );
}

migrate().catch((err) => {
  console.error("❌ 마이그레이션 중 오류:", err);
  process.exit(1);
});
