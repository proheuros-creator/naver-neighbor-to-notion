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
const FORMULA_PROP_NAME = 'BlogID_f';  // (이제 참조만 가능, 채우지는 않음)
const TEXT_PROP_NAME = 'BlogID';       // text (최종 blogId 저장)
const YEAR_PROP_NAME = '연도';
const YEARMONTH_PROP_NAME = '연월';
const QUARTER_PROP_NAME = '분기';
const DATE_PROP_NAME = '원본 날짜';
const GROUP_PROP_NAME = 'Group';       // multi_select (CSV 기반 그룹 태그)
const NICKNAME_PROP_NAME = 'Nickname'; // 닉네임 속성 (rich_text/title/select 권장)
const URL_PROP_CANDIDATES = ['URL', 'Url', '링크', '주소', 'Link'];

// ───────────────────────────────────────────────
// 📥 neighbor-followings-result.csv → BlogID-Group-Nickname 매핑
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

// blogId -> { groups: string[], nickname: string }
const BLOG_META_MAP = new Map();

(function loadBlogMetaMap() {
  if (!csvPath) {
    console.warn(
      '⚠️ neighbor-followings-result.csv 를 찾지 못했습니다. → Group/Nickname 매핑 없이 BlogID/연도 관련 마이그레이션만 수행합니다.'
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

      if (!blogId) continue;

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

      const nicknameRaw =
        row.nickname ||
        row.nickName ||
        row.Nickname ||
        row.NickName ||
        row.bloggerName ||
        row.BloggerName ||
        row.name ||
        row.Name ||
        row['별명'] ||
        row['닉네임'] ||
        '';

      BLOG_META_MAP.set(blogId, {
        groups,
        nickname: String(nicknameRaw || '').trim(),
      });
      mapped++;
    }

    console.log(
      `✅ CSV (${csvPath}) 에서 BlogID-Group-Nickname 매핑 ${BLOG_META_MAP.size}개 로드 (rows: ${records.length})`
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

// title → plain text
function getPlainTextFromTitle(prop) {
  if (!prop || prop.type !== 'title' || !prop.title) return '';
  return prop.title.map((r) => r.plain_text || '').join('').trim();
}

// select → name
function getSelectName(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select?.name?.trim() || '';
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
// URL → blogId 추출
// ───────────────────────────────────────────────
function extractBlogIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/blog\.naver\.com\/([^/?\s]+)\/\d+/i);
  return m ? m[1] : null;
}

// 페이지의 속성들에서 URL 찾아오기
function getUrlFromProperties(props) {
  // 1) 후보 이름으로 직접 찾기
  for (const name of URL_PROP_CANDIDATES) {
    if (props[name] && props[name].type === 'url') {
      return props[name].url || '';
    }
  }
  // 2) 어떤 이름이든 type이 url인 속성 찾기
  for (const [k, v] of Object.entries(props)) {
    if (v && v.type === 'url' && typeof v.url === 'string' && v.url) {
      return v.url;
    }
  }
  return '';
}

// Nickname 현재값 가져오기 (타입별)
function getCurrentNickname(props) {
  const p = props[NICKNAME_PROP_NAME];
  if (!p) return '';
  if (p.type === 'rich_text') return getPlainTextFromRichText(p);
  if (p.type === 'title') return getPlainTextFromTitle(p);
  if (p.type === 'select') return getSelectName(p);
  return ''; // people/relation 등은 동기화 대상에서 제외
}

// Nickname 업데이트 payload 만들기 (타입별)
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
  // people / relation 등은 스킵
  return null;
}

// ───────────────────────────────────────────────
// 🚀 메인 마이그레이션
// ───────────────────────────────────────────────
async function migrate() {
  console.log(
    `🚀 URL→BlogID + 연도/연월/분기 + Group(sync) + Nickname(CSV) 마이그레이션 시작` +
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
  let updatedNickname = 0;

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

      // 0) URL에서 blogId 추출 (기본 소스)
      const url = getUrlFromProperties(props);
      const blogIdFromUrl = extractBlogIdFromUrl(url);

      // (참고) formula나 기존 텍스트 값도 구해두되, 우선순위는 URL
      const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
      const blogIdText = getPlainTextFromRichText(props[TEXT_PROP_NAME]);

      // 텍스트 BlogID가 비어있거나 URL에서 추출한 값과 다르면 URL값으로 동기화
      if (blogIdFromUrl) {
        if (!blogIdText || blogIdText !== blogIdFromUrl) {
          if (props[TEXT_PROP_NAME]?.type === 'rich_text') {
            updates[TEXT_PROP_NAME] = {
              rich_text: [{ text: { content: blogIdFromUrl } }],
            };
            updatedBlogId++;
          }
        }
      }

      const effectiveBlogId = (blogIdFromUrl || blogIdText || formulaValue || '').trim();

      // 1) 연도/연월/분기 (각각 비어 있을 때만)
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

      // 2) Group 동기화 (multi_select) — CSV 기준
      if (
        effectiveBlogId &&
        BLOG_META_MAP.size > 0 &&
        props[GROUP_PROP_NAME]
      ) {
        const expectedGroups = BLOG_META_MAP.get(effectiveBlogId)?.groups || [];
        if (expectedGroups.length > 0) {
          if (props[GROUP_PROP_NAME].type === 'multi_select') {
            const currentGroups = getMultiSelectNames(props[GROUP_PROP_NAME]);
            if (!arraysEqualIgnoreOrder(currentGroups, expectedGroups)) {
              updates[GROUP_PROP_NAME] = {
                multi_select: expectedGroups.map((name) => ({ name })),
              };
              updatedGroup++;
            }
          }
        }
      }

      // 3) Nickname 동기화 (CSV 우선) — text/title/select 지원
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
            `🎉 최종: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname}`
          );
          return;
        }
      }

      if (scanned % 500 === 0) {
        console.log(
          `📊 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname}`
        );
      }
    }

    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  console.log(
    `🎉 완료: 스캔 ${scanned} / 업데이트 ${updatedPages} / BlogID ${updatedBlogId} / 연도 ${updatedYear} / 연월 ${updatedYearMonth} / 분기 ${updatedQuarter} / Group ${updatedGroup} / Nickname ${updatedNickname}`
  );
}

migrate().catch((err) => {
  console.error('❌ 마이그레이션 중 오류:', err);
  process.exit(1);
});
