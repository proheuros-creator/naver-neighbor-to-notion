import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// MIGRATE_DATABASE_ID가 있으면 우선 사용, 없으면 기본 NOTION_DATABASE_ID
const databaseId =
  process.env.MIGRATE_DATABASE_ID || process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error(
    '❌ 마이그레이션 대상 DB ID (MIGRATE_DATABASE_ID 또는 NOTION_DATABASE_ID)가 없습니다.'
  );
  process.exit(1);
}

// 이번 실행에서 "실제로 업데이트할 최대 페이지 수"
// 설정 안 하면(0 또는 undefined) 무제한
const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || '0', 10) || 0;

// 노션 속성 이름들
const FORMULA_PROP_NAME = 'BlogID';
const TEXT_PROP_NAME = 'ID';
const YEAR_PROP_NAME = '연도';
const YEARMONTH_PROP_NAME = '연월';
const QUARTER_PROP_NAME = '분기';
const DATE_PROP_NAME = '원본 날짜';

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
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  let q;
  if (month <= 3) q = 'Q1';
  else if (month <= 6) q = 'Q2';
  else if (month <= 9) q = 'Q3';
  else q = 'Q4';

  const quarter = `${year}-${q}`;

  return { year, yearMonth, quarter };
}

// Notion 업데이트 재시도 로직
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

      const code = err.code || err.status || err.type;
      const status = err.status;
      const message = err.message || '';

      const retriable =
        code === 'rate_limited' ||
        code === 'ECONNRESET' ||
        code === 'service_unavailable' ||
        status === 503 ||
        message.includes('socket hang up') ||
        message.includes('ECONNRESET');

      if (!retriable || attempt >= retries) {
        throw err;
      }

      const delayMs = 1000 * attempt;
      console.log(
        `⚠️ Notion 업데이트 실패 (${code || status || 'unknown'}), 재시도 ${attempt}/${retries} (page: ${pageId})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function migrate() {
  console.log(
    `🚀 BlogID → ID + 연도/연월/분기 마이그레이션 시작` +
      (MIGRATE_LIMIT
        ? ` (이번 실행 최대 ${MIGRATE_LIMIT}건 업데이트)`
        : ' (업데이트 건수 제한 없음)')
  );

  let cursor = undefined;
  let processed = 0;
  let updatedPages = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;

  // 아직 마이그레이션이 필요한 페이지만 조회
  const baseFilter = {
    or: [
      {
        property: TEXT_PROP_NAME,
        rich_text: { is_empty: true },
      },
      {
        property: YEAR_PROP_NAME,
        rich_text: { is_empty: true },
      },
      {
        property: YEARMONTH_PROP_NAME,
        rich_text: { is_empty: true },
      },
      {
        property: QUARTER_PROP_NAME,
        rich_text: { is_empty: true },
      },
    ],
  };

  mainLoop: while (true) {
    const resp = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
      filter: baseFilter,
    });

    if (resp.results.length === 0) {
      if (!resp.has_more) break;
    }

    for (const page of resp.results) {
      processed++;
      const props = page.properties;
      const updates = {};

      // 1) BlogID formula → ID text
      if (props[FORMULA_PROP_NAME] && props[TEXT_PROP_NAME]) {
        const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
        const textProp = props[TEXT_PROP_NAME];

        const hasText =
          textProp.type === 'rich_text' &&
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
          p.type === 'rich_text' && p.rich_text.length > 0;
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
          p.type === 'rich_text' && p.rich_text.length > 0;
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
          p.type === 'rich_text' && p.rich_text.length > 0;
        if (!has) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [{ text: { content: quarter } }],
          };
          updatedQuarter++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await safeUpdatePage(page.id, updates);
        await new Promise((resolve) => setTimeout(resolve, 50)); // 부하 완화용

        updatedPages++;

        if (processed % 500 === 0) {
          console.log(
            `📊 처리 ${processed}행 / 업데이트된 페이지 ${updatedPages} / ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
          );
        }

        // 🔚 이번 실행 상한 도달 시 종료
        if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) {
          console.log(
            `⏹ MIGRATE_LIMIT(${MIGRATE_LIMIT}) 도달, 이번 실행 종료`
          );
          break mainLoop;
        }
      }
    }

    if (!resp.has_more) {
      break;
    }
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 마이그레이션 종료: 처리 ${processed}행 / 업데이트된 페이지 ${updatedPages} / ID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
