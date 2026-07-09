/**
 * ============================================================
 *  UX/UI Dashboard — Jira Proxy (Google Apps Script)
 *  ทำหน้าที่: ดึงข้อมูล Jira board UXUI แบบสด แล้วส่งให้ dashboard.html
 *  Token เก็บไว้ที่นี่ (ฝั่ง server) ไม่หลุดไปในไฟล์ที่แชร์
 * ============================================================
 *
 *  วิธีตั้งค่า (ทำครั้งเดียว):
 *  1. เปิด https://script.google.com → New project
 *  2. วางโค้ดนี้ทับทั้งหมด
 *  3. เมนูซ้าย ⚙ Project Settings → Script Properties → Add property
 *     ใส่ 4 ตัวนี้ (ห้ามเขียน token ลงในโค้ดตรงๆ):
 *        JIRA_EMAIL   = อีเมล Atlassian ของคุณ เช่น firsty@skilllane.com
 *        JIRA_TOKEN   = API token (สร้างที่ id.atlassian.com/manage-profile/security/api-tokens)
 *        JIRA_DOMAIN  = skilllane.atlassian.net
 *        ACCESS_KEY   = รหัสลับที่คุณตั้งเอง เช่น uxui-2026-x7k9m2  (ยาวๆ เดายาก)
 *  4. Deploy → New deployment → เลือก type "Web app"
 *        - Execute as:  Me (ตัวคุณเอง — token จะถูกใช้ในนามคุณ)
 *        - Who has access:  "Anyone"  ← สำคัญ! ต้องเป็น Anyone ไม่ใช่ within domain
 *          (เพราะ fetch() จากหน้าเว็บผ่าน within-domain ไม่ได้ — โดน login redirect
 *           เรากันคนอื่นด้วย ACCESS_KEY ใน URL แทน ปลอดภัยพอสำหรับข้อมูล internal)
 *  5. คัดลอก Web app URL ที่ได้ (จะเป็นแบบ /macros/s/.../exec ไม่มี /a/macros/domain)
 *     แล้วต่อ ?key=ACCESS_KEY ท้าย URL → เอาไปวางใน dashboard ช่อง PROXY_URL
 *     ตัวอย่าง: https://script.google.com/macros/s/AKfy.../exec?key=uxui-2026-x7k9m2
 *
 *  หมายเหตุสำคัญเรื่อง URL:
 *  - ถ้า URL มี /a/macros/skilllane.com/ = ยังตั้ง within-domain อยู่ → fetch ไม่ผ่าน
 *  - ต้องได้ URL แบบ /macros/s/.../exec (ไม่มี /a/) = ตั้ง Anyone ถูกแล้ว
 */

var JQL = 'project = UXUI ORDER BY created DESC';
var FIELDS = [
  'summary','status','assignee','issuetype','priority',
  'created','updated','duedate','timeoriginalestimate',
  'aggregatetimeoriginalestimate','timespent','aggregatetimespent',
  'components','labels','parent','resolutiondate'
];
var MAX_ISSUES = 800; // เผื่อ board โต ปรับได้

function doGet(e) {
  try {
    // --- ตรวจ secret key (กันคนอื่นเรียก แม้ตั้ง access = Anyone) ---
    var props = PropertiesService.getScriptProperties();
    var expected = props.getProperty('ACCESS_KEY');
    var given = (e && e.parameter && e.parameter.key) || '';
    if (expected && given !== expected) {
      return json_({ ok: false, error: 'unauthorized (key ไม่ถูกต้อง)', issues: [] });
    }

    var issues = fetchAllIssues_();
    var clean = issues.map(transformIssue_);
    var payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      count: clean.length,
      issues: clean
    };
    return json_(payload);
  } catch (err) {
    return json_({ ok: false, error: String(err), issues: [] });
  }
}

function fetchAllIssues_() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('JIRA_EMAIL');
  var token = props.getProperty('JIRA_TOKEN');
  var domain = props.getProperty('JIRA_DOMAIN');
  if (!email || !token || !domain) {
    throw new Error('ยังไม่ได้ตั้ง Script Properties: JIRA_EMAIL / JIRA_TOKEN / JIRA_DOMAIN');
  }
  var auth = 'Basic ' + Utilities.base64Encode(email + ':' + token);
  var base = 'https://' + domain + '/rest/api/3/search/jql';

  var all = [];
  var nextPageToken = null;
  var guard = 0;
  do {
    var body = {
      jql: JQL,
      fields: FIELDS,
      maxResults: 100
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    var res = UrlFetchApp.fetch(base, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: auth, Accept: 'application/json' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      throw new Error('Jira API ตอบ ' + code + ': ' + res.getContentText().slice(0, 300));
    }
    var data = JSON.parse(res.getContentText());
    all = all.concat(data.issues || []);
    nextPageToken = data.isLast ? null : data.nextPageToken;
    guard++;
  } while (nextPageToken && all.length < MAX_ISSUES && guard < 20);

  return all;
}

function sec2h_(s) { return s ? Math.round(s / 3600 * 100) / 100 : 0; }

function transformIssue_(i) {
  var f = i.fields || {};
  var a = f.assignee || {};
  var par = f.parent || {};
  var parF = par.fields || {};
  var sc = (f.status && f.status.statusCategory) || {};
  var comps = (f.components || []).map(function(c){ return c.name; });
  return {
    key: i.key,
    summary: f.summary || '',
    type: (f.issuetype && f.issuetype.name) || '',
    status: (f.status && f.status.name) || '',
    statusCat: sc.name || '',
    assignee: a.displayName || 'Unassigned',
    assigneeId: a.accountId || '',
    priority: (f.priority && f.priority.name) || 'None',
    created: (f.created || '').slice(0, 10),
    updated: (f.updated || '').slice(0, 10),
    due: f.duedate || null,
    resolved: (f.resolutiondate || '').slice(0, 10) || null,
    estH: sec2h_(f.timeoriginalestimate),
    aggEstH: sec2h_(f.aggregatetimeoriginalestimate),
    spentH: sec2h_(f.timespent),
    aggSpentH: sec2h_(f.aggregatetimespent),
    labels: f.labels || [],
    // "Project label" in the dashboard = Jira Components field.
    // projectLabels keeps all of them; projectLabel is the first, used as
    // the primary grouping key by the dashboard.
    projectLabels: comps,
    projectLabel: comps.length ? comps[0] : null,
    parentKey: par.key || null,
    parentSummary: parF.summary || null
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** ทดสอบใน editor ได้: กด Run ฟังก์ชันนี้ ดู log ว่าดึงได้กี่งาน */
function testFetch() {
  var issues = fetchAllIssues_();
  Logger.log('ดึงได้ ' + issues.length + ' งาน');
  Logger.log(JSON.stringify(transformIssue_(issues[0]), null, 2));
}
