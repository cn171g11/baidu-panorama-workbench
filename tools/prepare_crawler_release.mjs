#!/usr/bin/env node
// Plan a cumulative Pages release; never import rows, modify config/data, or publish a site.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = 'dist/crawler-1125-release-plan';
const COUNTERS = ['rawRecords', 'uniquePanoids', 'existingIds', 'exactDuplicates', 'differingDuplicates', 'invalidRecords'];
const fmt = new Intl.NumberFormat('zh-CN').format;
const cityID = id => typeof id === 'string' && /^\d{6}$/.test(id);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const sum = (items, key) => items.reduce((n, item) => n + item[key], 0);

function idList(value, key) {
  assert(Array.isArray(value) && value.length && value.every(cityID) && new Set(value).size === value.length,
    `${key} must be an explicit list of distinct six-digit city IDs`);
  return new Set(value);
}

// Never serialize the full importer result (catalog, individual observations, source paths, etc.).
// existingIds counts input records matching the pre-import archive; batch-only repeats count as
// duplicates as well but are not archive matches and must not inflate a city's merged count.
function publicDelta(report) {
  assert(object(report) && object(report.cities), 'Expected an importer batch report with a cities object');
  const totals = Object.fromEntries(COUNTERS.map(key => {
    assert(count(report[key]), `Invalid importer counter ${key}`);
    return [key, report[key]];
  }));
  const duplicates = totals.exactDuplicates + totals.differingDuplicates;
  assert(totals.existingIds <= duplicates, 'existingIds must be a subset of all duplicates');
  assert.equal(totals.rawRecords, totals.uniquePanoids + duplicates + totals.invalidRecords, 'rawRecords does not reconcile');
  const rows = Object.entries(report.cities).map(([id, city]) => {
    assert(cityID(id) && object(city), 'Invalid report city');
    const { name, added, merged } = city;
    assert(typeof name === 'string' && name === name.trim() && /^[\p{L}\p{M}\p{N} ()（）·・-]{1,96}$/u.test(name), `Expected a public city name for ${id}`);
    assert(count(added) && count(merged), `Invalid added/merged counters for city ${id}`);
    return { id, name, added, merged };
  }).filter(row => row.added || row.merged).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(sum(rows, 'added'), totals.uniquePanoids, 'Sum of per-city added must equal uniquePanoids');
  assert.equal(sum(rows, 'merged'), totals.existingIds, 'Sum of per-city merged must equal existingIds');
  assert(rows.length, 'No added or matched records to release');
  return { totals, rows };
}

const SOURCE_KEYS = ['hidden', 'time-machine', 'regular', 'unknown', 'missing', 'other'];
const ENTRY_KEYS = ['hidden', 'time-machine', 'regular', 'unknown'];
const STATUS_LABELS = {
  'user-confirmed-hidden': '用户确认隐藏', 'regular-confirmed': '已确认常规',
  'time-machine-roundtrip': '日期往返实测', 'time-machine-one-way': '单向到达',
  'time-machine-history-only': '仅明确历史引用（非日期往返实测）',
  'hidden-candidate': '隐藏候选', 'access-error': '访问错误', unknown: '待确认',
};

// These two populations overlap after import. Never add their counts together. The public release
// needs category totals only, not paths, records, evidence traces, or per-file/per-city counters.
function publicAudit(audit, report) {
  assert(audit?.schemaVersion === 2 && audit.scope === 'canonical-and-input-rows-separate', 'Expected an audit with separate catalog and upload populations');
  const archiveTotal = report.catalog?.total ?? (count(report.existingCount) ? report.existingCount + report.uniquePanoids : null);
  assert(count(archiveTotal), 'Need importer catalog.total or existingCount to bind audit to the post-import archive');
  if (report.existingCount !== undefined) assert(count(report.existingCount) && archiveTotal === report.existingCount + report.uniquePanoids, 'Importer archive total does not reconcile');
  assert(audit.catalog?.byBasis?.['binzhou-user-confirmed-source'] === 7418 && audit.catalog?.byBasis?.['tumushuke-user-confirmed-source'] === 11796,
    'Audit must retain the Binzhou and Tumushuke manual baselines');
  function group(input, rows) {
    assert.equal(input?.rows, rows, 'Audit row count does not match the importer');
    function distribution(values, allowed) {
      assert(object(values) && Object.entries(values).every(([key, n]) => allowed.includes(key) && count(n)), 'Invalid audit distribution');
      const result = Object.fromEntries(allowed.map(key => [key, values[key] ?? 0]));
      assert.equal(Object.values(result).reduce((a, b) => a + b, 0), rows, 'Audit distribution does not reconcile');
      return result;
    }
    const bySource = distribution(input.bySource, SOURCE_KEYS), byCategory = distribution(input.byCategory, ENTRY_KEYS);
    const byStatus = distribution(input.byStatus, Object.keys(STATUS_LABELS));
    assert(byStatus['regular-confirmed'] === byCategory.regular && byStatus['user-confirmed-hidden'] === byCategory.hidden
      && byStatus['time-machine-roundtrip'] + byStatus['time-machine-one-way'] + byStatus['time-machine-history-only'] === byCategory['time-machine']
      && byStatus.unknown + byStatus['hidden-candidate'] + byStatus['access-error'] === byCategory.unknown, 'Audit status/category mismatch');
    return { rows, bySource, byCategory, byStatus };
  }
  return { catalog: group(audit.catalog, archiveTotal), uploads: group(audit.uploads, report.rawRecords) };
}
const categoryLabels = { hidden: '隐藏', 'time-machine': '时光机', regular: '常规', unknown: '待确认', missing: '未标注', other: '其他' };
function auditText(label, { rows, bySource, byCategory, byStatus }) {
  const show = d => Object.entries(d).map(([key, n]) => `${categoryLabels[key]} ${fmt(n)}`).join('、');
  const statuses = Object.entries(byStatus).filter(([, n]) => n > 0).map(([key, n]) => `${STATUS_LABELS[key]} ${fmt(n)}`).join('、');
  return `${label}（${fmt(rows)} 条，不含小蓝点）：显式来源标签为${show(bySource)}；按入口记录、明确历史引用与人工基线复核为${show(byCategory)}。证据状态：${statuses || '无记录'}。未标注不视作已确认常规。`;
}

export function planCrawlerRelease({ report, publication, notes, audit, version = '1.10.0', date }) {
  assert(publication?.schemaVersion === 1 && publication.provider === 'baidu' && publication.mode === 'pages-gzip'
    && publication.domesticSupplementOnly === true && !('hiddenOnly' in publication) && !('hiddenOnlyCities' in publication), 'Expected cumulative domestic supplement Pages policy');
  const domestic = idList(publication.cities, 'cities');
  const overseas = idList(publication.overseasSourceCities, 'overseasSourceCities');
  assert(overseas.has('191001') && [...overseas].every(id => !domestic.has(id)), 'Invalid or overlapping overseas selection');
  assert(notes?.schemaVersion === 1 && notes.current?.version === '1.9.0' && notes.releases?.[0]?.version === '1.9.0', 'This batch must follow the 1.9.0 baseline');
  assert(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split('.').map(Number).every(count), 'Invalid release version');
  const [major, minor, patch] = version.split('.').map(Number);
  assert((major > 1 || (major === 1 && (minor > 9 || (minor === 9 && patch > 0)))) && !notes.releases.some(item => item.version === version), 'Version must be new and later than 1.9.0');
  assert(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date && date >= notes.current.date, 'Provide a valid release date no earlier than the baseline');

  const { totals, rows } = publicDelta(report);
  const auditCounts = audit === undefined ? null : publicAudit(audit, report);
  for (const { id, added } of rows) {
    assert(!overseas.has(id), `Domestic batch unexpectedly touches overseas city ${id}`);
    // A match alone changes provenance, not the owner's classification or eligibility for publication.
    if (added > 0) domestic.add(id);
  }
  const policy = { ...publication, cities: [...domestic], note: '国内发布原补充来源标注的 hidden / time-machine、经人工确认的 regular 及 11.25 批次明确标为 metadata-only 的 unknown；其他国内旧常规或待确认记录不随城市加入而开放。海外来源仍合并到 191001；小蓝点独立发布。' };
  const highlights = [`11.25 爬虫批次新增 ${fmt(totals.uniquePanoids)} 个待确认街景；匹配已有 panoid 的 ${fmt(totals.existingIds)} 条记录不重复计点。`];
  const release = {
    version, date, title: '11.25 爬虫街景归档与入口证据说明',
    changes: [
      `本批输入 ${fmt(totals.rawRecords)} 条：新增 ${fmt(totals.uniquePanoids)} 个 panoid，完全相同重复 ${fmt(totals.exactDuplicates)} 条、内容不同重复 ${fmt(totals.differingDuplicates)} 条，无效 ${fmt(totals.invalidRecords)} 条。所有重复中，命中导入前归档 ${fmt(totals.existingIds)} 条，按原归属计入逐城合并；只在批内重复的不计为旧库匹配。`,
      `逐城表列出 ${fmt(rows.length)} 个有新增或合并的地区。国内白名单在旧清单上增加 ${fmt(domestic.size - publication.cities.length)} 个有新增点的地区。表中新增是归档增量，不是线上总点数变化；小蓝点不在本批统计内。`,
      '新增街景仅有爬虫元数据（metadata-only），入口分类为 unknown（待确认）。原始 hidden 标签、movementCount、Links 或 TimeLine 不能单独证明地图入口、道路单向通行、日期往返或隐藏；合并观察也不覆盖已有主记录的分类。',
      '城市归属与街景类型分开判断：边界包含与按候选边界距离推定不是同一证据。最近或有歧义的归属只在候选范围内成立，不是官方行政区认证，也不证明街景入口可达。',
      '既有人工基线单列：滨州原始批次的 7,418 个隐藏 ID，不含后来 21 条来源标注；图木舒克 11,796 条常规由用户逐条确认（user-confirmed-regular，见 v1.9.0）。官网样本只证明已记录的入口操作，不能把少量操作外推到同城整批。以上不是本批新增或逐条官网实测的计数。',
      ...(auditCounts ? [auditText('导入后归档', auditCounts.catalog), auditText('本批上传输入', auditCounts.uploads), '以上是归档主记录和本批输入的两个统计范围，存在重叠，不能相加；归档数也不是 Pages 已发布点位数。'] : []),
    ],
    importCounts: totals, cityAdditions: rows, ...(auditCounts ? { auditCounts } : {}),
  };
  return { publication: policy, notes: { ...notes, current: { version, date, highlights }, releases: [release, ...notes.releases] } };
}

const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export async function prepareCrawlerRelease({ root = ROOT, report, audit, date, version, output = DEFAULT_OUTPUT }) {
  root = await realpath(root);
  const dist = path.join(root, 'dist'), directory = path.resolve(root, output);
  assert(path.dirname(directory) === dist && /^crawler-1125-release-plan(?:-[\w-]+)?$/.test(path.basename(directory)), 'Use a fresh, private dist/crawler-1125-release-plan[-suffix] directory');
  const [stats, publication, notes, review] = await Promise.all([
    json(path.resolve(root, report)), json(path.join(root, 'config/pages-publication.json')), json(path.join(root, 'config/release-notes.json')),
    audit ? json(path.resolve(root, audit)) : undefined,
  ]);
  const plan = planCrawlerRelease({ report: stats, publication, notes, audit: review, date, version });
  await mkdir(dist, { recursive: true });
  assert.equal(await realpath(dist), dist, 'Refusing symlinked dist');
  await mkdir(directory); // Exclusive: no overwrite, including plans from a failed or concurrent run.
  for (const [name, value] of [['pages-publication', plan.publication], ['release-notes', plan.notes]]) {
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return directory;
}

const USAGE = 'Usage: node tools/prepare_crawler_release.mjs --report <import-report.json> --date YYYY-MM-DD [--audit <v2-audit.json>] [--version 1.10.0] [--output dist/crawler-1125-release-plan[-suffix]]';
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log(USAGE);
    else {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i], value = args[i + 1];
        assert(['--report', '--date', '--audit', '--output', '--version'].includes(key) && value && !value.startsWith('--') && !(key.slice(2) in options), USAGE);
        options[key.slice(2)] = value;
      }
      assert(options.report && options.date, USAGE);
      console.log('Release plan only (config and data unchanged):', await prepareCrawlerRelease(options));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
