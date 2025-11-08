import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 노션 속성 이름들
const FORMULA_PROP_NAME = 'BlogID';   // formula
const TEXT_PROP_NAME = 'ID';          // text
const YEAR_PROP_NAME = '연도';        // text
const YEARMONTH_PROP_NAME = '연월';   // text
const QUARTER_PROP_NAME = '분기';     // text
const DATE_PROP_NAME = '원본 날짜';    // date

if (!databaseId) {
  console.error('❌ NOTION_DATABASE_ID 가 없습니다.');
  process.exit(1);
}

function extractFormulaValue(formulaProp) {
  if (!formulaProp || formulaProp.type !== 'formula') return null;
  const f = formulaProp.formula;
  if (!f) return null;

  if (f.type === 'string') return f.string || null;
  if (f.type === 'number' && f.number != null) return String(f.number);
  if (f.type === 'boolean') return String(f.boolean);
  if (f.type === 'date' && f.date?.start) return f.date.start;
  return null;
}

function extractYyYmQ(dateProp) {
  if (!dateProp || dateProp.type !== 'date' || !dateProp.date?.start) {
    return { year: null, yearMonth: null, quarter: null };
  }

  const raw = dateProp.date.start;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    return { year: null, yearMonth: null, quarter: null };
  }

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1; // 1~12
  const mm = String(month).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  let q;
  if (month <= 3) q = 'Q1';
  else if (month <= 6) q = 'Q2';
  else if (month <= 9) q = 'Q3';
  else q = 'Q4';

  const quarter = `${year}-${q}`; // 예: 2025-Q1

  return { year, yearMonth, quarter };
}

// Notion 페이지 업데이트 재시도 헬퍼
async function safeUpdatePage(pageId, properties, retries = 3) {
  let attempt = 0;
  while (true) {
    try {
      await notion.pages.update({
        page_id: pageId,
        properties,
      });
      return;
    } catch (err) {
      attempt++;

      // 재시도 가능한 에러 유형
      const code = err.code || err.status || err.type;
      const message = err.message || '';

      const retriable =
        code === 'rate_limited' ||
        code === 'ECONNRESET' ||
        message.includes('socket hang up') ||
        message.includes('ECONNRESET');

      if (!retriable || attempt >= retries) {
        throw err;
      }

      // 간단한 backoff
      const delayMs = 500 * attempt;
      console.log(`⚠️ 업데이트 실패, 재시도 ${attempt}/${retries} (대상: ${pageId})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function migrate() {
  console.log('🚀 BlogID → ID + 연도/연월/분기 마이그레이션 시작');

  let cursor = undefined;
  let processed = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;

  while (true) {
    const resp = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of resp.results) {
      processed++;
      const props = page.properties;
      const updates = {};

      // 1) BlogID (formula) → ID (text)
      if (props[FORMULA_PROP_NAME] && props[TEXT_PROP_NAME]) {
        const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
        const textProp = props[TEXT_PROP_NAME];

        const hasText =
          textProp.type === 'rich_text' &&
          textProp.rich_text.length > 0;

        if (formulaValue && !hasText) {
          updates[TEXT_PROP_NAME] = {
            rich_text: [
              {
                text: { content: formulaValue },
              },
            ],
          };
          updatedBlogId++;
        }
      }

      // 2) 원본 날짜 → 연도 / 연월 / 분기
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const yearProp = props[YEAR_PROP_NAME];
        const hasYear =
          yearProp.type === 'rich_text' &&
          yearProp.rich_text.length > 0;

        if (!hasYear) {
          updates[YEAR_PROP_NAME] = {
            rich_text: [
              {
                text: { content: year },
              },
            ],
          };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const ymProp = props[YEARMONTH_PROP_NAME];
        const hasYearMonth =
          ymProp.type === 'rich_text' &&
          ymProp.rich_text.length > 0;

        if (!hasYearMonth) {
          updates[YEARMONTH_PROP_NAME] = {
            rich_text: [
              {
                text: { content: yearMonth },
              },
            ],
          };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const qProp = props[QUARTER_PROP_NAME];
        const hasQuarter =
          qProp.type === 'rich_text' &&
          qProp.rich_text.length > 0;

        if (!hasQuarter) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [
              {
                text: { content: quarter },
              },
            ],
          };
          updatedQuarter++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await safeUpdatePage(page.id, updates);
      }

      if (processed % 500 === 0) {
        console.log(
          `📊 처리 ${processed}행 / BlogID→ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
        );
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 총 ${processed}행 / BlogID→ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
