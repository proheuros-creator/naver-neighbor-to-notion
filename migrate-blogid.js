import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 노션 속성 이름: 실제 DB의 컬럼명과 정확히 맞춰주세요
const FORMULA_PROP_NAME = 'BlogID';        // 기존 blogId 수식 컬럼 (formula)
const TEXT_PROP_NAME = 'BlogID_text';      // blogId 텍스트 컬럼 (text)
const YEAR_PROP_NAME = '연도';             // 연도 (text)
const YEARMONTH_PROP_NAME = '연월';        // 연월 (text)
const QUARTER_PROP_NAME = '분기';          // 분기 (text)
const DATE_PROP_NAME = '원본 날짜';        // 기준 날짜 (date)

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
  if (month >= 1 && month <= 3) q = 'Q1';
  else if (month >= 4 && month <= 6) q = 'Q2';
  else if (month >= 7 && month <= 9) q = 'Q3';
  else q = 'Q4';

  const quarter = `${year}-${q}`; // 예: 2025-Q1

  return { year, yearMonth, quarter };
}

async function migrate() {
  console.log('🚀 BlogID + 연도/연월/분기 마이그레이션 시작');

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

      // 1) BlogID Formula → BlogID_text (비어 있을 때만)
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

      // 2) 원본 날짜 → 연도 / 연월 / 분기 (비어 있을 때만)
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

      // 3) 업데이트 실행
      if (Object.keys(updates).length > 0) {
        await notion.pages.update({
          page_id: page.id,
          properties: updates,
        });
      }

      if (processed % 500 === 0) {
        console.log(
          `📊 처리 ${processed}행 / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
        );
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 총 ${processed}행 / BlogID_text ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
