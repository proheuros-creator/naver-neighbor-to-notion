import 'dotenv/config';
import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ESM 환경용 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ 마이그레이션 대상 DB
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

// ✅ 이번 실행에서 실제 업데이트 최대 건수 (0 = 제한 없음)
const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || '0', 10) || 0;

// ✅ Notion 속성 이름들
const FORMULA_PROP_NAME = 'BlogID_f'; // formula
const TEXT_PROP_NAME = 'BlogID';      // text (최종 blogId 저장)
const YEAR_PROP_NAME = '연도';
const YEARMONTH_PROP_NAME = '연월';
const QUARTER_PROP_NAME = '분기';
const DATE_PROP_NAME = '원본 날짜';
const GROUP_PROP_NAME = 'Group';      // multi_select (CSV 기반 그룹 태그)

// ───────────────────────────────────────────────
// 📥 neighbor-followings-result.csv → BlogID-Group 매핑
//    실제 위치: migrate-blogid.js와 같은 폴더 (또는 FOLLOWINGS_CSV_PATH)
// ───────────────────────────────────────────────
const explicitCsvPath = process.env.FOLLOWINGS_CSV_PATH
  ? path.resolve(process.env.FOLLOWINGS_CSV_PATH)
  : null;

let csvPath = null;

if (explicitCsvPath && fs.existsSync(explicitCsvPath)) {
  csvPath = explicitCsvPath;
} else {
  const sameDirPath = path.resolve(__dirname, 'neighbor-followings-result.csv');
  if (fs.existsSync(sameDirPath)) {
    csvPath = sameDirPath;
  }
}

const BLOGID_GROUP_MAP = new Map();

(function loadBlogGroupMap() {
  if (!csvPath) {
    console.warn(
      '⚠️ neighbor-followings-result.csv 를 찾지 못했습니다. → Group 매핑 없이 BlogID/연도 관련 마이그레이션만 수행합니다.'
    );
    return;
  }

  try {
    const records = parse(fs.readFileSync(csvPath), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    let mapped = 0;

    for (const row of records) {
      const blogId = String(
        row.blogID ||
          row.blogId ||
          row.blogid ||
          row.BlogID ||
          row.BLOGID ||
          row.blog_id ||
          ''
      ).trim();

      const rawGroup =
        row.groupNames ||
        row.GroupNames ||
        row.groupName ||
        row.GroupName ||
        row.group ||
        row.Group ||
        '';

      // "A,B,C" 형태도 지원
      const groups = String(rawGroup || '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

      if (!blogId || groups.length === 0) continue;

      BLOGID_GROUP_MAP.set(blogId, groups);
      mapped++;
    }

    console.log(
      `✅ CSV (${csvPath}) 에서 BlogID-Group 매핑 ${BLOGID_GROUP_MAP.size}개 로드 (rows: ${records.length})`
    );
  } catch (err) {
    console.error('❌ neighbor-followings-result.csv 파싱 실패:', err);
  }
})();

// ───────────────────────────────────────────────
// 유틸 함수들
// ───────────────────────────────────────────────

// formula → string
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

// rich_text → plain text
function getPlainTextFromRichText(prop) {
  if (!prop || prop.type !== 'rich_text' || !prop.rich_text) return '';
  return prop.rich_text.map((r) => r.plain_text || '').join('').trim();
}

// multi_select → name 배열
function getMultiSelectNames(prop) {
  if (!prop || prop.type !== 'multi_select' || !prop.multi_select) return [];
  return prop.multi_select
    .map((o) => (o && o.name ? o.name.trim() : ''))
    .filter((v) => v.length > 0);
}

// 배열 비교 (순서 무시)
function arraysEqualIgnoreOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// 날짜 → 연/연월/분기
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
  const q = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
  const quarter = `${year}-${q}`;

  return { year, yearMonth, quarter };
}

// databases.query 재시도
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

      const delay = 1000 * attempt;
      console.log(`⏳ ${delay / 1000}s 대기 후 databases.query 재시도...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// pages.update 재시도
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
// 🚀 메인 마이그레이션
// ───────────────────────────────────────────────
async function migrate() {
  console.log(
    `🚀 BlogID_f → BlogID + 연도/연월/분기 + Group(sync) 마이그레이션 시작` +
      (MIGRATE_LIMIT
        ? ` (이번 실행 최대 ${MIGRATE_LIMIT}건 업데이트)`
        : ' (업데이트 건수 제한 없음)')
  );

  let cursor;
  let scanned = 0;
  let updatedPages = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;
  let updatedGroup = 0;

  while (true) {
    const resp = await queryWithRetry({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 50,
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

      // 1) BlogID_f → BlogID (빈 경우만)
      const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
      const blogIdText = getPlainTextFromRichText(props[TEXT_PROP_NAME]);

      if (formulaValue && !blogIdText) {
        updates[TEXT_PROP_NAME] = {
          rich_text: [{ text: { content: formulaValue } }],
        };
        updatedBlogId++;
      }

      const effectiveBlogId = (blogIdText || formulaValue || '').trim();

      // 2) 연도/연월/분기 (각각 비어 있을 때만)
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[YEAR_PROP_NAME]);
        if (!cur) {
          updates[YEAR_PROP_NAME] = {
            rich_text: [{ text: { content: year } }],
          };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[YEARMONTH_PROP_NAME]);
        if (!cur) {
          updates[YEARMONTH_PROP_NAME] = {
            rich_text: [{ text: { content: yearMonth } }],
          };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[QUARTER_PROP_NAME]);
        if (!cur) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [{ text: { content: quarter } }],
          };
          updatedQuarter++;
        }
      }

      // 3) Group 동기화 (multi_select)
      if (
        effectiveBlogId &&
        BLOGID_GROUP_MAP.size > 0 &&
        props[GROUP_PROP_NAME]
      ) {
        const expectedGroups = BLOGID_GROUP_MAP.get(effectiveBlogId); // ['A', 'B', ...]
        if (expectedGroups && expectedGroups.length > 0) {
          if (props[GROUP_PROP_NAME].type === 'multi_select') {
            const currentGroups = getMultiSelectNames(props[GROUP_PROP_NAME]);

            // 다를 때만 업데이트 → 여러 번 실행해도 이미 맞으면 스킵
            if (!arraysEqualIgnoreOrder(currentGroups, expectedGroups)) {
              updates[GROUP_PROP_NAME] = {
                multi_select: expectedGroups.map((name) => ({ name })),
              };
              updatedGroup++;
            }
          } else {
            // 타입이 multi_select가 아니면 건너뜀 (스키마 불일치)
            // 필요하면 여기서 console.warn 찍어도 됨
          }
        }
      }

      // 실제로 바꿀 값이 있을 때만 업데이트
      if (Object.keys(updates).length > 0) {
        try {
          await safeUpdatePage(page.id, updates);
          updatedPages++;
        } catch {
          // safeUpdatePage에서 로그 처리함 → 계속 진행
        }

        // rate limit 완화
        await new Promise((r) => setTimeout(r, 80));

        // MIGRATE_LIMIT 도달 체크
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

      if (scanned % 500 === 0) {
        console.log(
          `📊 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup}`
        );
      }
    }

    if (!resp.has_more) break;
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
