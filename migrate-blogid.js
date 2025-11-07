import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 설정: 여기 이름을 네 DB 속성명에 맞게 바꿔줘
const FORMULA_PROP_NAME = 'BlogID';        // 기존 formula 컬럼 이름
const TEXT_PROP_NAME = 'ID';      // 새 text 컬럼 이름

async function migrate() {
  if (!databaseId) {
    console.error('❌ NOTION_DATABASE_ID 가 없습니다.');
    process.exit(1);
  }

  console.log('🚀 BlogID Formula → Text 마이그레이션 시작');

  let cursor = undefined;
  let processed = 0;
  let updated = 0;

  while (true) {
    const resp = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of resp.results) {
      processed++;

      const props = page.properties;

      const formulaProp = props[FORMULA_PROP_NAME];
      const textProp = props[TEXT_PROP_NAME];

      // formula 결과 읽기
      let formulaValue = null;
      if (formulaProp && formulaProp.type === 'formula') {
        const f = formulaProp.formula;
        if (f.type === 'string') formulaValue = f.string;
        else if (f.type === 'number' && f.number != null) formulaValue = String(f.number);
        else if (f.type === 'boolean') formulaValue = String(f.boolean);
        else if (f.type === 'date' && f.date?.start) formulaValue = f.date.start;
      }

      // 이미 텍스트 값이 있으면 스킵
      const hasText =
        textProp &&
        textProp.type === 'rich_text' &&
        textProp.rich_text.length > 0;

      if (!formulaValue || hasText) {
        continue;
      }

      // 업데이트
      await notion.pages.update({
        page_id: page.id,
        properties: {
          [TEXT_PROP_NAME]: {
            rich_text: [
              {
                text: { content: formulaValue },
              },
            ],
          },
        },
      });

      updated++;
      if (updated % 100 === 0) {
        console.log(`✅ 현재까지 ${updated}개 업데이트 (전체 처리 ${processed}행)`);
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(`🎉 마이그레이션 완료: 총 ${processed}행 중 ${updated}행에 BlogID_text 채움`);
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
