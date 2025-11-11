import 'dotenv/config';
import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ✅ ESM 환경에서 __dirname 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ 마이그레이션 대상 DB 선택 우선순위
const databaseId =
  process.env.MIGRATE_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID_BLOGSCARP ||
  process.env.NOTION_DATABASE_ID_BLOGSCARPTEMP;

if (!databaseId) {
  console.error(
    '❌ 마이그레이션 대상 DB ID가 없습니다. MIGRATE_DATABASE_ID 또는 관련 NOTION_DATABASE_ID_* 환경변수를 설정하세요.'
  );
  process.exit(1);
}

// 이번 실행에서 "실제로 업데이트할 최대 건수" (0이면 제한 없음)
const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || '0', 10) || 0;

// Notion 속성 이름들
const FORMULA_PROP_NAME = 'BlogID_f'; // 기존: BlogID, 변경: BlogID_f (formula)
const TEXT_PROP_NAME = 'BlogID';      // 기존: ID, 변경: BlogID (text)
const YEAR_PROP_NAME = '연도';
const YEARMONTH_PROP_NAME = '연월';
const QUARTER_PROP_NAME = '분기';
const DATE_PROP_NAME = '원본 날짜';
const GROUP_PROP_NAME = 'Group';      // CSV 기반으로 채울 Group 컬럼

// ───────────────────────────────────────────────
// 📥 neighbor-followings-result.csv → BlogID-Group 매핑
// ───────────────────────────────────────────────
const csvPath = process.env.FOLLOWINGS_CSV_PATH
  ? path.resolve(process.env.FOLLOWINGS_CSV_PATH)
  : path.resolve(__dirname, '../neighbor-followings-result.csv');

const BLOGID_GROUP_MAP = new Map();

(function loadBlogGroupMap() {
  if (!fs.existsSync(csvPath)) {
    console.warn(
      `⚠️ neighbor-followings-result.csv 를 찾지 못했습니다: ${csvPath}\n` +
        '   → Group 매핑 없이 BlogID 마이그레이션만 수행합니다.'
    );
    return;
  }

  try {
    const file = fs.readFileSync(csvPath);
    const records = parse(file, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    let mapped = 0;
    for (const row of records) {
      const blogIdRaw =
        row.blogId ||
        row.blogid ||
        row.BLOGID ||
        row.BlogID ||
        row.blog_id ||
        '';
      const groupRaw =
        row.group ||
        row.Group ||
        row.groupName ||
        row.GroupName ||
        '';

      const blogId = String(blogIdRaw || '').trim();
      const group = String(groupRaw || '').trim();

      if (!blogId || !group) continue;

      // 동일 blogId가 여러 번 나오면 마지막 값 기준 (필요시 여기서 조건 조정 가능)
      BLOGID_GROUP_MAP.set(blogId, group);
      mapped++;
    }

    console.log(
      `✅ CSV 로부터 BlogID-Group 매핑 ${BLOGID_GROUP_MAP.size}개 로드 (raw rows: ${records.length})`
    );
  } catch (err) {
    console.error('❌ neighbor-followings-result.csv 파싱 실패:', err);
  }
})();

// ───────────────────────────────────────────────
// 🔍 Formula 값 추출 (BlogID_f formula → string)
// ───────────────────────────────────────────────
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

// ───────────────────────────────────────────────
// 📅 원본 날짜 → 연/연월/분기 계산
// ───────────────────────────────────────────────
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

// ───────────────────────────────────────────────
// 🔁 databases.query 재시도 (타임아웃/일시 오류 방어)
// ───────────────────────────────────────────────
async function queryWithRetry(params, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await notion.databases.query(params);
    } catch (err) {
      const code = err.code || err.status || err.name;
      const msg = err.message || String(err);

      const retriable =
        code === 'notionhq_client_request_timeout' ||
        code === 'rate_limited' ||
        code === 'ECONNRESET' ||
        code === 'service_unavailable' ||
        err.status === 503 ||
        msg.includes('socket hang up') ||
        msg.includes('ECONNRESET');

      console.warn(
        `⚠️ databases.query 실패 (${attempt}/${retries}) : [${code}] ${msg}`
      );

      if (!retriable || attempt === retries) {
        console.error('❌ databases.query 재시도 한계 도달, 에러 발생');
        throw err;
      }

      const delay = 1000 * attempt; // 1s, 2s, 3s
      console.log(`⏳ ${delay / 1000}s 대기 후 databases.query 재시도...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ───────────────────────────────────────────────
// 🔁 페이지 업데이트 재시도 (rate limit/네트워크)
// ───────────────────────────────────────────────
async function safeUpdatePage(pageId, properties, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await notion.pages.update({
        page_id: pageId,
        properties,
      });
      return;
    } catch (err) {
      const code = err.code || err.status || err.name;
      const msg = err.message || String(err);

      const retriable =
        code === 'notionhq_client_request_timeout' ||
        code === 'rate_limited' ||
        code === 'ECONNRESET' ||
        code === 'service_unavailable' ||
        err.status === 503 ||
        msg.includes('socket hang up') ||
        msg.includes('ECONNRESET');

      console.warn(
        `⚠️ Notion 업데이트 실패 (${attempt}/${retries}) : [${code}] ${msg} (page: ${pageId})`
      );

      if (!retriable || attempt === retries) {
        console.error(
          `❌ Notion 업데이트 포기 (page: ${pageId}) → 이 페이지는 건너뜀`
        );
        throw err;
      }

      const delay = 1000 * attempt;
      console.log(`⏳ ${delay / 1000}s 대기 후 update 재시도...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ───────────────────────────────────────────────
// 🚀 메인 마이그레이션 루프
// ───────────────────────────────────────────────
async function migrate() {
  console.log(
    `🚀 BlogID_f → BlogID + 연도/연월/분기 + Group 마이그레이션 시작` +
      (MIGRATE_LIMIT
        ? ` (이번 실행 최대 ${MIGRATE_LIMIT}건 업데이트)`
        : ' (업데이트 건수 제한 없음)')
  );

  let cursor = undefined;

  let scanned = 0;
  let updatedPages = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;
  let updatedGroup = 0;

  // ✅ "아직 마이그레이션 안 된 페이지" + Group 비어있는 페이지 대상으로 필터
  const baseFilter = {
    or: [
      { property: TEXT_PROP_NAME, rich_text: { is_empty: true } },
      { property: YEAR_PROP_NAME, rich_text: { is_empty: true } },
      { property: YEARMONTH_PROP_NAME, rich_text: { is_empty: true } },
      { property: QUARTER_PROP_NAME, rich_text: { is_empty: true } },
      { property: GROUP_PROP_NAME, rich_text: { is_empty: true } },
    ],
  };

  console.log('🔍 첫 batch 조회 시작 (databases.query)...');

  mainLoop: while (true) {
    const resp = await queryWithRetry({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 50, // 작게 유지해서 안정성 확보
      filter: baseFilter,
    });

    const pages = resp.results || [];
    console.log(`📥 batch 수신: ${pages.length}개`);

    if (pages.length === 0) {
      if (!resp.has_more) break;
      cursor = resp.next_cursor;
      continue;
    }

    for (const page of pages) {
      scanned++;

      const props = page.properties;
      const updates = {};

      // 1) BlogID_f formula → BlogID 텍스트
      let blogIdFromFormula = null;

      if (props[FORMULA_PROP_NAME] && props[TEXT_PROP_NAME]) {
        blogIdFromFormula = extractFormulaValue(props[FORMULA_PROP_NAME]);
        const textProp = props[TEXT_PROP_NAME];
        const hasText =
          textProp.type === 'rich_text' && textProp.rich_text.length > 0;

        if (blogIdFromFormula && !hasText) {
          updates[TEXT_PROP_NAME] = {
            rich_text: [{ text: { content: blogIdFromFormula } }],
          };
          updatedBlogId++;
        }
      }

      // ✅ effectiveBlogId: 우선 text BlogID, 없으면 formula 값
      let effectiveBlogId = null;
      const textProp = props[TEXT_PROP_NAME];
      if (
        textProp &&
        textProp.type === 'rich_text' &&
        textProp.rich_text.length > 0
      ) {
        effectiveBlogId = textProp.rich_text
          .map((r) => r.plain_text || '')
          .join('')
          .trim();
      } else if (blogIdFromFormula) {
        effectiveBlogId = blogIdFromFormula.trim();
      }

      // 2) 원본 날짜 기반 연/연월/분기
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const p = props[YEAR_PROP_NAME];
        const has = p.type === 'rich_text' && p.rich_text.length > 0;
        if (!has) {
          updates[YEAR_PROP_NAME] = {
            rich_text: [{ text: { content: year } }],
          };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const p = props[YEARMONTH_PROP_NAME];
        const has = p.type === 'rich_text' && p.rich_text.length > 0;
        if (!has) {
          updates[YEARMONTH_PROP_NAME] = {
            rich_text: [{ text: { content: yearMonth } }],
          };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const p = props[QUARTER_PROP_NAME];
        const has = p.type === 'rich_text' && p.rich_text.length > 0;
        if (!has) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [{ text: { content: quarter } }],
          };
          updatedQuarter++;
        }
      }

      // 3) BlogID 기반 Group 매핑
      if (
        effectiveBlogId &&
        BLOGID_GROUP_MAP.size > 0 &&
        props[GROUP_PROP_NAME]
      ) {
        const groupValue = BLOGID_GROUP_MAP.get(effectiveBlogId);
        if (groupValue) {
          const g = props[GROUP_PROP_NAME];
          const has =
            g.type === 'rich_text' && g.rich_text.length > 0;
          if (!has) {
            updates[GROUP_PROP_NAME] = {
              rich_text: [{ text: { content: groupValue } }],
            };
            updatedGroup++;
          }
        }
      }

      // 실제로 바꿀 값이 있을 때만 Notion 업데이트
      if (Object.keys(updates).length > 0) {
        try {
          await safeUpdatePage(page.id, updates);
        } catch {
          // safeUpdatePage 안에서 이미 로그 출력 & 포기 처리 → 여기서는 계속 진행
        }
        updatedPages++;

        // 부하 완화
        await new Promise((r) => setTimeout(r, 80));
      }

      // 진행 상황 로그
      if (scanned % 500 === 0) {
        console.log(
          `📊 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup}`
        );
      }

      // MIGRATE_LIMIT 도달 시 종료
      if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) {
        console.log(
          `⏹ MIGRATE_LIMIT(${MIGRATE_LIMIT}) 도달 → 이번 실행 종료`
        );
        console.log(
          `🎉 최종: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup}`
        );
        return;
      }
    }

    if (!resp.has_more) {
      break;
    }
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
