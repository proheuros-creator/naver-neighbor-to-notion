/**
 * migrate-url-blogid-group-nickname-processed.js
 * ───────────────────────────────────────────────
 * 🧭 기능 요약
 *  - URL(https://blog.naver.com/{blogId}/{postId})에서 blogId 추출 → BlogID(Text) 동기화
 *  - neighbor-followings-result.csv에서 Group(multi_select), Nickname 동기화
 *  - 원본 날짜(Date)로 연/연월/분기 채움 (비어 있을 때만)
 *  - ✅ 방법 A: Notion DB의 ProcessedAt(Date)로 처리 완료 마킹(중복 스캔 방지)
 *  - ✅ 정렬 기준: DB의 "생성 일시"(date 속성) 기준으로 **가장 최신부터** 처리
 */

import 'dotenv/config';
import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ 대상 DB
const databaseId =
  process.env.MIGRATE_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID ||
  process.env.NOTION_DATABASE_ID_BLOGSCARP ||
  process.env.NOTION_DATABASE_ID_BLOGSCARPTEMP;

if (!databaseId) {
  console.error('❌ DB ID가 없습니다. MIGRATE_DATABASE_ID 또는 NOTION_DATABASE_ID_* 를 설정하세요.');
  process.exit(1);
}

// ✅ 실행당 최대 업데이트 건수 (0 = 제한 없음)
const MIGRATE_LIMIT = parseInt(process.env.MIGRATE_LIMIT || '0', 10) || 0;

// ✅ Notion 속성 이름
const FORMULA_PROP_NAME    = 'BlogID_f';     // (참조만)
const TEXT_PROP_NAME       = 'BlogID';       // rich_text(Text)
const YEAR_PROP_NAME       = '연도';          // rich_text(Text)
const YEARMONTH_PROP_NAME  = '연월';          // rich_text(Text)
const QUARTER_PROP_NAME    = '분기';          // rich_text(Text)
const DATE_PROP_NAME       = '원본 날짜';      // date
const GROUP_PROP_NAME      = 'Group';        // multi_select
const NICKNAME_PROP_NAME   = 'Nickname';     // rich_text or title or select
const PROCESSED_PROP_NAME  = 'ProcessedAt';  // date (방법 A 핵심)
const CREATION_PROP_NAME   = '생성 일시';     // ✅ 정렬 기준으로 사용할 DB의 date 속성
const URL_PROP_CANDIDATES  = ['URL', 'Url', '링크', '주소', 'Link'];

// ───────────────────────────────────────────────
// CSV 로드 (blogId → groups[], nickname)
// ───────────────────────────────────────────────
const explicitCsvPath = process.env.FOLLOWINGS_CSV_PATH
  ? path.resolve(process.env.FOLLOWINGS_CSV_PATH)
  : null;

let csvPath = null;
if (explicitCsvPath && fs.existsSync(explicitCsvPath)) {
  csvPath = explicitCsvPath;
} else {
  const sameDirPath = path.resolve(__dirname, 'neighbor-followings-result.csv');
  if (fs.existsSync(sameDirPath)) csvPath = sameDirPath;
}

const BLOG_META_MAP = new Map(); // blogId → { groups: string[], nickname: string }

(function loadBlogMeta() {
  if (!csvPath) {
    console.warn('⚠️ CSV를 찾지 못했습니다. → Group/Nickname 동기화 없이 진행합니다.');
    return;
  }
  try {
    const records = parse(fs.readFileSync(csvPath), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    for (const row of records) {
      const blogId = String(
        row.blogID || row.blogId || row.blogid || row.BlogID || row.BLOGID || row.blog_id || ''
      ).trim();
      if (!blogId) continue;

      const rawGroup =
        row.groupNames || row.GroupNames || row.groupName || row.GroupName || row.group || row.Group || '';
      const groups = String(rawGroup || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

      const nicknameRaw =
        row.nickname || row.nickName || row.Nickname || row.NickName ||
        row.bloggerName || row.BloggerName || row.name || row.Name ||
        row['별명'] || row['닉네임'] || '';

      BLOG_META_MAP.set(blogId, { groups, nickname: String(nicknameRaw || '').trim() });
    }
    console.log(`✅ CSV 로드: ${BLOG_META_MAP.size}개 blogId 매핑 (from ${csvPath})`);
  } catch (err) {
    console.error('❌ CSV 파싱 실패:', err);
  }
})();

// ───────────────────────────────────────────────
// 유틸
// ───────────────────────────────────────────────
function extractFormulaValue(prop) {
  if (!prop || prop.type !== 'formula') return null;
  const f = prop.formula;
  if (!f) return null;
  if (f.type === 'string') return f.string || null;
  if (f.type === 'number' && f.number != null) return String(f.number);
  if (f.type === 'boolean') return String(f.boolean);
  if (f.type === 'date' && f.date?.start) return f.date.start;
  return null;
}

function getPlainTextFromRichText(prop) {
  if (!prop || prop.type !== 'rich_text' || !prop.rich_text) return '';
  return prop.rich_text.map((r) => r.plain_text || '').join('').trim();
}

function getPlainTextFromTitle(prop) {
  if (!prop || prop.type !== 'title' || !prop.title) return '';
  return prop.title.map((r) => r.plain_text || '').join('').trim();
}

function getSelectName(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select?.name?.trim() || '';
}

function getMultiSelectNames(prop) {
  if (!prop || prop.type !== 'multi_select' || !prop.multi_select) return [];
  return prop.multi_select.map((o) => (o?.name ? o.name.trim() : '')).filter(Boolean);
}

function arraysEqualIgnoreOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function extractYyYmQ(dateProp) {
  if (!dateProp || dateProp.type !== 'date' || !dateProp.date?.start) {
    return { year: null, yearMonth: null, quarter: null };
  }
  const d = new Date(dateProp.date.start);
  if (isNaN(d.getTime())) return { year: null, yearMonth: null, quarter: null };
  const year = String(d.getFullYear());
  const m = d.getMonth() + 1;
  const mm = String(m).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  const quarter = `${year}-${q}`;
  return { year, yearMonth, quarter };
}

function extractBlogIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/blog\.naver\.com\/([^/?\s]+)\/\d+/i);
  return m ? m[1] : null;
}

function getUrlFromProperties(props) {
  for (const name of URL_PROP_CANDIDATES) {
    if (props[name]?.type === 'url') return props[name].url || '';
  }
  for (const v of Object.values(props)) {
    if (v?.type === 'url' && typeof v.url === 'string' && v.url) return v.url;
  }
  return '';
}

function getCurrentNickname(props) {
  const p = props[NICKNAME_PROP_NAME];
  if (!p) return '';
  if (p.type === 'rich_text') return getPlainTextFromRichText(p);
  if (p.type === 'title') return getPlainTextFromTitle(p);
  if (p.type === 'select') return getSelectName(p);
  return ''; // people/relation 등은 동기화 제외
}

function buildNicknameUpdate(prop, nickname) {
  if (!prop || !nickname) return null;
  if (prop.type === 'rich_text') {
    return { [NICKNAME_PROP_NAME]: { rich_text: [{ text: { content: nickname } }] } };
  }
  if (prop.type === 'title') {
    return { [NICKNAME_PROP_NAME]: { title: [{ text: { content: nickname } }] } };
  }
  if (prop.type === 'select') {
    return { [NICKNAME_PROP_NAME]: { select: { name: nickname } } };
  }
  return null;
}

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
      console.warn(`⚠️ databases.query 실패 (${attempt}/${retries}) : [${code}] ${msg}`);
      if (!retriable || attempt === retries) throw err;
      const delay = 1000 * attempt;
      console.log(`⏳ ${delay / 1000}s 대기 후 재시도...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function safeUpdatePage(pageId, properties, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await notion.pages.update({ page_id: pageId, properties });
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
      console.warn(`⚠️ update 실패 (${attempt}/${retries}) : [${code}] ${msg} (page: ${pageId})`);
      if (!retriable || attempt === retries) throw err;
      const delay = 1000 * attempt;
      console.log(`⏳ ${delay / 1000}s 대기 후 재시도...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ───────────────────────────────────────────────
/** 🚀 메인 (방법 A: ProcessedAt 마킹 + "생성 일시" 기준 최신부터 처리) */
// ───────────────────────────────────────────────
async function migrate() {
  console.log(
    `🚀 URL→BlogID + 연/연월/분기 + Group(sync) + Nickname(CSV) + ProcessedAt 마이그레이션 시작` +
      (MIGRATE_LIMIT ? ` (최대 ${MIGRATE_LIMIT}건)` : '')
  );

  let cursor;
  let scanned = 0;
  let updatedPages = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;
  let updatedGroup = 0;
  let updatedNickname = 0;
  let processedMarkedOnly = 0;

  while (true) {
    const resp = await queryWithRetry({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 50,
      // ✔ 처리 안 된 페이지만 스캔
      filter: {
        property: PROCESSED_PROP_NAME,
        date: { is_empty: true },
      },
      // ✅ 정렬: DB의 "생성 일시"(date 속성) 기준 최신부터
      sorts: [{ property: CREATION_PROP_NAME, direction: 'descending' }],
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

      // 1) URL → blogId
      const url = getUrlFromProperties(props);
      const blogIdFromUrl = extractBlogIdFromUrl(url);
      const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
      const blogIdText = getPlainTextFromRichText(props[TEXT_PROP_NAME]);

      if (blogIdFromUrl && props[TEXT_PROP_NAME]?.type === 'rich_text') {
        if (!blogIdText || blogIdText !== blogIdFromUrl) {
          updates[TEXT_PROP_NAME] = { rich_text: [{ text: { content: blogIdFromUrl } }] };
          updatedBlogId++;
        }
      }

      const effectiveBlogId = (blogIdFromUrl || blogIdText || formulaValue || '').trim();

      // 2) 연/연월/분기 (비어 있을 때만)
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[YEAR_PROP_NAME]);
        if (!cur) {
          updates[YEAR_PROP_NAME] = { rich_text: [{ text: { content: year } }] };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[YEARMONTH_PROP_NAME]);
        if (!cur) {
          updates[YEARMONTH_PROP_NAME] = { rich_text: [{ text: { content: yearMonth } }] };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const cur = getPlainTextFromRichText(props[QUARTER_PROP_NAME]);
        if (!cur) {
          updates[QUARTER_PROP_NAME] = { rich_text: [{ text: { content: quarter } }] };
          updatedQuarter++;
        }
      }

      // 3) Group 동기화 (multi_select)
      if (effectiveBlogId && BLOG_META_MAP.size > 0 && props[GROUP_PROP_NAME]?.type === 'multi_select') {
        const expectedGroups = BLOG_META_MAP.get(effectiveBlogId)?.groups || [];
        if (expectedGroups.length > 0) {
          const currentGroups = getMultiSelectNames(props[GROUP_PROP_NAME]);
          if (!arraysEqualIgnoreOrder(currentGroups, expectedGroups)) {
            updates[GROUP_PROP_NAME] = {
              multi_select: expectedGroups.map((name) => ({ name })),
            };
            updatedGroup++;
          }
        }
      }

      // 4) Nickname 동기화 (CSV 우선): rich_text/title/select 지원
      if (effectiveBlogId && BLOG_META_MAP.size > 0 && props[NICKNAME_PROP_NAME]) {
        const nicknameCsv = BLOG_META_MAP.get(effectiveBlogId)?.nickname || '';
        if (nicknameCsv) {
          const curNickname = getCurrentNickname(props);
          if (curNickname !== nicknameCsv) {
            const nickUpdate = buildNicknameUpdate(props[NICKNAME_PROP_NAME], nicknameCsv);
            if (nickUpdate) {
              Object.assign(updates, nickUpdate);
              updatedNickname++;
            }
          }
        }
      }

      // 5) 처리 마킹 (업데이트 여부와 무관하게 이번 배치에서 본 것은 마킹)
      updates[PROCESSED_PROP_NAME] = { date: { start: new Date().toISOString() } };

      try {
        await safeUpdatePage(page.id, updates);
        updatedPages++;
        if (Object.keys(updates).length === 1) processedMarkedOnly++; // ProcessedAt만 변경한 경우
      } catch {
        // 에러 로그는 safeUpdatePage 내부에서 처리
      }

      // rate limit 완화
      await new Promise((r) => setTimeout(r, 80));

      if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) {
        console.log('⏹ MIGRATE_LIMIT 도달 → 종료');
        console.log(
          `🎉 최종: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname} / 마킹만 ${processedMarkedOnly}`
        );
        return;
      }

      if (scanned % 500 === 0) {
        console.log(
          `📊 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname} / 마킹만 ${processedMarkedOnly}`
        );
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname} / 마킹만 ${processedMarkedOnly}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 오류:', err);
  process.exit(1);
});
