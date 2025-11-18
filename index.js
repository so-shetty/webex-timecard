// index.js — Webex Timecards bot (fixed PUT/update logic, safe id storage)
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // v2
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_EMAIL = "timely1@webex.bot";
const PORT = process.env.PORT || 3000;
const WEBEX_API = "https://webexapis.com/v1";

// Auto-stop threshold in minutes (4 hours = 240 minutes)
const AUTO_STOP_MINUTES = 4 * 60;


if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set. Add it to your .env file.");
  process.exit(1);
}

// -------------------- Setup --------------------
const app = express();
app.use(bodyParser.json());
app.use((req, res, next) => {
  console.log("📥 Incoming:", req.method, req.url);
  next();
});

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// -------------------- In-memory registry --------------------
/**
users[personId] = {
  roomId,
  personEmail,
  lastCardMessageId, // main card (card message)
  timersCardMessageId, // optional, separate card showing timers (card message)
  activeTimers: { [timerId]: { project, notes, startedAt, roomId, createdAt } }
}
*/
const users = {};


// -------------------- File helpers --------------------
function userTimecardFile(personId) { return path.join(DATA_DIR, `${personId}.json`); }
function userProjectFile(personId) { return path.join(DATA_DIR, `${personId}.projects.json`); }
function userTimersFile(personId) { return path.join(DATA_DIR, `${personId}.timers.json`); }

function loadUserTimecards(personId) {
  try {
    const f = userTimecardFile(personId);
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    }
  } catch (e) { console.error("loadUserTimecards:", e); }
  return [];
}
function saveUserTimecards(personId, arr) {
  try { fs.writeFileSync(userTimecardFile(personId), JSON.stringify(arr, null, 2)); }
  catch (e) { console.error("saveUserTimecards:", e); }
}

function loadUserProjects(personId) {
  try {
    const f = userProjectFile(personId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { console.error("loadUserProjects:", e); }
  return []; // start empty (fallback will be provided)
}
function saveUserProjects(personId, list) {
  try { fs.writeFileSync(userProjectFile(personId), JSON.stringify(list, null, 2)); }
  catch (e) { console.error("saveUserProjects:", e); }
}
function addProjectIfMissing(personId, projectName) {
  if (!projectName || !projectName.trim()) return;
  const normalized = projectName.trim();
  const list = loadUserProjects(personId);
  const found = list.some(p => p.name.toLowerCase() === normalized.toLowerCase());
  if (!found) {
    list.unshift({ name: normalized, createdAt: new Date().toISOString() });
    saveUserProjects(personId, list);
    console.log("Added project for", personId, normalized);
  }
}

function loadUserTimers(personId) {
  try {
    const f = userTimersFile(personId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { console.error("loadUserTimers:", e); }
  return {}; // map timerId => timer
}
function saveUserTimers(personId, timersObj) {
  try { fs.writeFileSync(userTimersFile(personId), JSON.stringify(timersObj, null, 2)); }
  catch (e) { console.error("saveUserTimers:", e); }
}

// -------------------- Utilities --------------------
function ensureUser(personId) {
  users[personId] = users[personId] || {};
  users[personId].activeTimers = users[personId].activeTimers || {};
  users[personId].roomId = users[personId].roomId || null;
  return users[personId];
}
function makeTimerId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function prettySince(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
}
function weekdayIndex(date, tzOffsetMinutes = 0) {
  const d = new Date(date.getTime() + tzOffsetMinutes * 60000);
  const jsDay = d.getUTCDay ? d.getUTCDay() : d.getDay();
  return (jsDay + 6) % 7;
}

// -------------------- Messaging helpers --------------------
async function sendMessage(optsOrRoom, textOrAttachments, maybeAttachments) {
  // Accept either ({roomId|toPersonEmail|toPersonId, text, attachments, markdown}) or (roomId, text, attachments)
  let opts = {};
  if (typeof optsOrRoom === "object" && optsOrRoom !== null && !Array.isArray(optsOrRoom)) {
    opts = optsOrRoom;
  } else {
    opts = { roomId: optsOrRoom, text: textOrAttachments, attachments: maybeAttachments };
  }
  const { roomId, toPersonEmail, toPersonId, text, attachments, markdown } = opts;
  const destCount = [roomId, toPersonEmail, toPersonId].filter(Boolean).length;
  if (destCount !== 1) {
    console.error("sendMessage wrong destination:", { roomId, toPersonEmail, toPersonId });
    throw new Error("Message must include exactly one destination");
  }
  const body = {};
  if (roomId) body.roomId = roomId;
  else if (toPersonEmail) body.toPersonEmail = toPersonEmail;
  else if (toPersonId) body.toPersonId = toPersonId;
  if (text) body.text = text;
  if (markdown) body.markdown = markdown;
  if (attachments) body.attachments = attachments;

  try {
    const res = await fetch(`${WEBEX_API}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (e) { }
    console.log("POST /messages status:", res.status, txt);
    return { ok: res.ok, status: res.status, bodyText: txt, json };
  } catch (err) {
    console.error("sendMessage error:", err);
    return { ok: false, error: err };
  }
}

// helper to fetch an existing message from webex (for validation)
async function fetchMessageById(messageId) {
  try {
    const res = await fetch(`${WEBEX_API}/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` }
    });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (e) { }
    return { ok: res.ok, status: res.status, json, raw: txt };
  } catch (err) {
    console.error("fetchMessageById error:", err);
    return { ok: false, error: err };
  }
}

// Update message by id (PUT). `card` should be the adaptive card object (not attachments array).
// This function now validates the existing message before attempting PUT to avoid invalid updates.
async function updateMessageById(messageId, roomId, text, cardContent) {
  try {
    const body = {
      roomId,
      text
    };

    if (cardContent) {
      body.attachments = [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: cardContent
        }
      ];
    }

    console.log("🚀 PUT BODY:", JSON.stringify(body, null, 2));

    const res = await fetch(`https://webexapis.com/v1/messages/${messageId}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const txt = await res.text();
    console.log("PUT /messages status:", res.status, txt);

    if (!res.ok) {
      console.error("❌ PUT FAILED:", txt);
      return null;
    }

    return JSON.parse(txt);

  } catch (err) {
    console.error("❌ PUT FAILED:", err);
    return null;
  }
}



// -------------------- Adaptive Card builders --------------------
function defaultProjectChoices() {
  return [
    { title: "Type a project in here ----->", value: "Type a project in here ----->" }
  ];
}

function getProjectChoicesForPerson(personId) {
  const list = loadUserProjects(personId);
  if (!list || !list.length) return defaultProjectChoices();
  return list.map(p => ({ title: p.name, value: p.name }));
}

function storeIfAdaptiveCard(userObj, fieldName, messageResponse) {
  try {
    if (
      messageResponse &&
      messageResponse.ok &&
      messageResponse.json &&
      messageResponse.json.attachments &&
      messageResponse.json.attachments.length > 0 &&
      messageResponse.json.attachments[0].contentType === "application/vnd.microsoft.card.adaptive"
    ) {
      userObj[fieldName] = messageResponse.json.id;
      console.log(`💾 Stored ${fieldName}:`, userObj[fieldName]);
    } else {
      console.log(`⛔ Not storing ${fieldName} — message is NOT an adaptive card.`);
    }
  } catch (err) {
    console.error("storeIfAdaptiveCard error:", err);
  }
}


function buildMainCard(personId, defaultValue = "") {
  const choices = getProjectChoicesForPerson(personId);
  const toast = users[personId].toastMainCard;
  const card = {
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": [
      // -----------------------------
      // ✅ TOAST GOES HERE
      // -----------------------------
      ...(users[personId]?.toastMainCard ? [{
        "type": "TextBlock",
        "text": toast,
        "color": "Attention",
        "weight": "Bolder",
        "wrap": true,
        "spacing": "Small"
      }] : []),

      { "type": "TextBlock", "text": "🕒 Timecard", "weight": "Bolder", "size": "Medium" },
      { "type": "TextBlock", "text": "Pick a project or type a new one:", "wrap": true, "spacing": "Small" },
      {
        "type": "ColumnSet",
        "columns": [
          {
            "type": "Column",
            "width": "stretch",
            "items": [
              {
                "type": "Input.ChoiceSet",
                "id": "projectDropdown",
                "style": "compact",
                "value": defaultValue || (choices[0] && choices[0].value) || "",
                "choices": choices
              }
            ]
          },
          {
            "type": "Column",
            "width": "auto",
            "items": [
              { "type": "Input.Text", "id": "newProject", "placeholder": "Or type new project", "maxLength": 100, "spacing": "None" }
            ]
          },
          {
            "type": "Column",
            "width": "auto",
            "items": [
              { "type": "ActionSet", "id": "refreshProjects", "actions": [{ "type": "Action.Submit", "title": "🔄", "data": { action: "refresh_projects" } }] }
            ]
          }
        ],
        "spacing": "Small"
      },
      { "type": "Input.Text", "id": "notes", "placeholder": "Notes (optional)", "isMultiline": false, "spacing": "Small" }
    ],
    "actions": [
      { "type": "Action.Submit", "title": "Start Timer", "data": { action: "start_timer" } },
      { "type": "Action.Submit", "title": "Show Timers", "data": { action: "show_timers" } },
      { "type": "Action.Submit", "title": "Manage Projects", "data": { action: "manage_projects" } },
      { "type": "Action.Submit", "title": "📊 Weekly Report", "data": { action: "show_weekly_report" } }
    ]
  };
  return card;
}

function consolidateTimers(timers) {
  const map = {};

  for (const t of timers) {
    const key = `${t.project}||${t.notes || ""}`;

    if (!map[key]) {
      map[key] = {
        project: t.project,
        notes: t.notes || "",
        totalMs: 0,
        segments: [],
        running: false
      };
    }

    const start = new Date(t.startedAt);
    const end = t.stoppedAt ? new Date(t.stoppedAt) : new Date();
    const elapsed = end - start;

    map[key].totalMs += elapsed;
    map[key].segments.push(elapsed);

    if (!t.stoppedAt) {
      map[key].running = true;
    }
  }

  return Object.values(map);
}

function consolidateActiveTimers(timersObj) {
  const now = Date.now();
  const map = {};

  for (const [tid, t] of Object.entries(timersObj)) {
    const key = `${t.project}||${(t.notes || "").trim()}`;

    if (!map[key]) {
      map[key] = {
        key,                       // <-- unique group key
        project: t.project,
        notes: t.notes || "",
        totalMs: 0,
        memberIds: []              // will hold original timer ids in this group
      };
    }

    const elapsedMs = now - new Date(t.startedAt).getTime();
    map[key].totalMs += elapsedMs;
    map[key].memberIds.push(tid);
  }

  return Object.values(map);
}



function buildTimersCard(personId) {
  const u = users[personId] || {};
  const timers = u.activeTimers || {};
  const toast = users[personId].toastTimersCard;
  users[personId].consolidatedMap = {};

  const now = Date.now();
  const body = [
    { "type": "TextBlock", "text": "⏱️ Active Timers", "weight": "Bolder", "size": "Medium" }
  ];

  // STEP 1: consolidate active timers (project + notes)
  const consolidated = consolidateActiveTimers(timers);

  if (!consolidated.length) {
    body.push({ "type": "TextBlock", "text": "No active timers.", "wrap": true });
  } else {
    body.push({
      "type": "TextBlock",
      "text": "Select timers to stop:",
      "weight": "Bolder",
      "spacing": "Small"
    });

    consolidated.forEach((c, idx) => {
      const elapsedPretty = prettySince(c.totalMs);
      const label = c.notes ? `${c.project} (${c.notes}) — ${elapsedPretty}` : `${c.project} — ${elapsedPretty}`;

      body.push({
        "type": "Input.Toggle",
        "id": `con_${idx}`,           // id used in inputs when the card is submitted
        "title": label,
        "valueOff": "false",
        "valueOn": "true"
      });

      // store mapping in users so the handler can map con_<idx> -> c.key
      users[personId] = users[personId] || {};
      users[personId].consolidatedMap = users[personId].consolidatedMap || {};
      users[personId].consolidatedMap[`con_${idx}`] = c.key;
    });
  }

  // Replace actions array with these three (no Back to Timecard)
  const card = {
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": body,
    "actions": [
      { "type": "Action.Submit", "title": "⏹ Stop Selected", "data": { action: "stop_selected_timers" } },
      { "type": "Action.Submit", "title": "⏹⏹ Stop All", "data": { action: "stop_all_timers" } },
      { "type": "Action.Submit", "title": "🔄 Refresh Timers", "data": { action: "refresh_timers" } }
    ]
  };


  if (toast) {
    card.body.unshift({
      type: "TextBlock",
      text: toast,
      color: "Good",
      weight: "Bolder",
      wrap: true,
      spacing: "Small"
    });
    users[personId].toastTimersCard = null;
  }

  return card;
}


function buildManageProjectsCard(personId) {
  const projects = getProjectChoicesForPerson(personId);
  return {
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": [
      { "type": "TextBlock", "text": "🗂️ Manage Projects", "weight": "Bolder", "size": "Medium" },
      { "type": "TextBlock", "text": "Select projects to delete (bulk):", "wrap": true, "spacing": "Small" },
      {
        "type": "Input.ChoiceSet",
        "id": "deleteProjects",
        "isMultiSelect": true,
        "style": "expanded",
        "choices": projects
      }
    ],
    "actions": [
      { "type": "Action.Submit", "title": "Delete Selected", "data": { action: "manage_delete_prepare" } },
      { "type": "Action.Submit", "title": "Cancel", "data": { action: "manage_cancel" } }
    ]
  };
}

function buildConfirmDeleteCard(names) {
  const list = names.map(n => `• ${n}`).join("\n");
  const namesEncoded = names.join("|");
  return {
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.3",
    "body": [
      { "type": "TextBlock", "text": "❗ Confirm Deletion", "weight": "Bolder", "size": "Medium" },
      { "type": "TextBlock", "text": "You are about to delete these project(s):", "wrap": true },
      { "type": "TextBlock", "text": list, "wrap": true, "spacing": "Small" }
    ],
    "actions": [
      { "type": "Action.Submit", "title": "Yes, Delete", "data": { action: "manage_delete_confirm", names: namesEncoded } },
      { "type": "Action.Submit", "title": "No, Cancel", "data": { action: "manage_cancel" } }
    ]
  };
}

// -------------------- Timer management --------------------
function persistActiveTimers(personId) {
  const u = users[personId] || {};
  const timers = u.activeTimers || {};
  saveUserTimers(personId, timers);

}



function restoreAllTimersOnStartup() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    for (const f of files) {
      if (f.endsWith('.timers.json')) {
        const personId = f.replace('.timers.json', '');
        try {
          const timers = loadUserTimers(personId);
          users[personId] = users[personId] || {};
          users[personId].activeTimers = timers || {};
          console.log("Restored timers for", personId, Object.keys(users[personId].activeTimers || {}).length);
        } catch (e) {
          console.error("Error restoring timers for", personId, e);
        }
      }
    }
  } catch (e) { console.error("restoreAllTimersOnStartup error:", e); }
}

async function sendFile(roomId, text, fileBuffer, filename) {
  const boundary = "----WebexBoundary" + Math.random().toString(16).slice(2);

  // Build multipart body manually
  const bodyParts = [];

  function addField(name, value) {
    bodyParts.push(`--${boundary}\r\n`);
    bodyParts.push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    bodyParts.push(value + "\r\n");
  }

  function addFile(name, filename, buffer) {
    bodyParts.push(`--${boundary}\r\n`);
    bodyParts.push(
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
    );
    bodyParts.push(`Content-Type: text/csv\r\n\r\n`);
    bodyParts.push(buffer);
    bodyParts.push(`\r\n`);
  }

  // Add fields
  addField("roomId", roomId);
  addField("text", text);
  addFile("files", filename, fileBuffer);

  // Close boundary
  bodyParts.push(`--${boundary}--\r\n`);

  // Convert to buffer
  const body = Buffer.concat(
    bodyParts.map(part => (typeof part === "string" ? Buffer.from(part) : part))
  );

  const res = await fetch("https://webexapis.com/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${BOT_TOKEN}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  const responseText = await res.text();
  console.log("📁 CSV multipart upload response:", res.status, responseText);

  if (!res.ok) {
    console.error("❌ CSV upload failed:", responseText);
    return null;
  }

  return JSON.parse(responseText);
}




function generateWeeklyPivotReport(personId) {
  const records = loadUserTimecards(personId) || [];

  // ------------------------------------------------------------
  // STEP 1 — Compute LOCAL Monday 00:00 and LOCAL Today 00:00
  // ------------------------------------------------------------
  const today = new Date();

  // Local midnight today
  const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // JS weekday: 0=Sun,1=Mon...
  const jsDay = today.getDay();
  const daysSinceMonday = (jsDay + 6) % 7;

  // Local Monday 00:00
  const localMonday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - daysSinceMonday
  );

  const startDate = localMonday;     // inclusive
  const endDate = localToday;        // inclusive

  // ------------------------------------------------------------
  // STEP 2 — Determine active weekdays (Mon → Today)
  // ------------------------------------------------------------
  const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const activeDaysCount = (jsDay === 0 ? 7 : jsDay);
  const activeDays = allDays.slice(0, activeDaysCount);

  // Map JS day index → report column
  const jsToCol = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 0: "sun" };

  // ------------------------------------------------------------
  // STEP 3 — Aggregate data by project and weekday
  // ------------------------------------------------------------
  const projects = {};   // { projectName: { mon:0, tue:0, ... , notes:Set() } }

  for (const rec of records) {
    const d = new Date(rec.ts);

    // FILTER: Only records between Monday 00:00 and END OF today
    const endOfRange = new Date(endDate.getTime() + 24 * 60 * 60 * 1000); // today 23:59

    if (d < startDate || d >= endOfRange) {
      continue;
    }

    const weekdayCol = jsToCol[d.getDay()];
    if (!activeDays.includes(weekdayCol)) {
      continue; // ignore future days of the week
    }

    const project = (rec.project || "Unknown").trim();

    // Ensure bucket exists
    if (!projects[project]) {
      projects[project] = {
        mon: 0, tue: 0, wed: 0, thu: 0,
        fri: 0, sat: 0, sun: 0,
        notes: new Set()
      };
    }

    // Add minutes
    projects[project][weekdayCol] += rec.minutes || 0;

    // Add notes (deduped)
    if (rec.notes && rec.notes.trim()) {
      projects[project].notes.add(rec.notes.trim());
    }
  }

  // ------------------------------------------------------------
  // STEP 4 — Build table rows (for display)
  // ------------------------------------------------------------
  const tableRows = [];
  const columnTotals = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };

  for (const [project, data] of Object.entries(projects)) {
    const row = { project };
    let total = 0;

    for (const col of activeDays) {
      const mins = data[col] || 0;
      row[col] = mins;
      total += mins;
      columnTotals[col] += mins;
    }

    row.total = total;
    tableRows.push(row);
  }

  // GRAND TOTAL row
  const totalRow = { project: "TOTAL" };
  let grandTotal = 0;

  for (const col of activeDays) {
    totalRow[col] = columnTotals[col];
    grandTotal += columnTotals[col];
  }

  totalRow.total = grandTotal;
  tableRows.push(totalRow);

  // ------------------------------------------------------------
  // STEP 5 — Build CSV rows
  // ------------------------------------------------------------
  const csvRows = [];

  for (const [project, data] of Object.entries(projects)) {
    const row = {
      project,
      notes: [...data.notes].join("; ")  // deduped notes
    };

    let total = 0;
    for (const col of activeDays) {
      const mins = data[col] || 0;
      row[col] = mins;
      total += mins;
    }

    row.total = total;
    csvRows.push(row);
  }

  // Add totals row to CSV
  const csvTotalRow = { project: "TOTAL", notes: "" };
  for (const col of activeDays) {
    csvTotalRow[col] = columnTotals[col];
  }
  csvTotalRow.total = grandTotal;
  csvRows.push(csvTotalRow);

  // ------------------------------------------------------------
  // STEP 6 — Notes section (for table bottom)
  // ------------------------------------------------------------
  const notesSection = Object.entries(projects).map(([project, data]) => ({
    project,
    notes: [...data.notes].join("; ")
  }));

  // Final object returned
  return {
    startDate: startDate.toISOString().split("T")[0],
    endDate: today.toISOString().split("T")[0], // today
    activeDays,
    tableRows,
    csvRows,
    notesSection
  };
}


function generateWeeklyPivotCSV(report) {
  const { activeDays, csvRows } = report;

  // Build header dynamically: project, mon, tue, ..., total, notes
  const headers = ["project", ...activeDays, "total", "notes"];
  const lines = [headers.join(",")];

  for (const row of csvRows) {
    const vals = [];

    // project
    vals.push(csvEscape(row.project));

    // each day
    for (const col of activeDays) {
      vals.push(csvEscape(row[col] || 0));
    }

    // total
    vals.push(csvEscape(row.total));

    // notes (already concatenated & deduped)
    vals.push(csvEscape(row.notes || ""));

    lines.push(vals.join(","));
  }

  return lines.join("\n");
}

// Escape fields for CSV
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  val = String(val);
  if (val.includes(",") || val.includes("\"") || val.includes("\n") || val.includes(";")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function createCSVBuffer(csvString) {
  return Buffer.from(csvString, "utf8");
}

function generateWeeklyPivotTableText(report) {
  const { tableRows, activeDays, notesSection, startDate, endDate } = report;

  const dayLabels = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun"
  };

  // ---- CONFIG ----
  const MIN_PROJECT_WIDTH = 12;
  const NUM_WIDTH = 5; // fixed width for Mon/Tue/Total numbers
  const GAP = "   ";   // spacing between columns

  // ----- Determine project column width -----
  let projectColWidth = MIN_PROJECT_WIDTH;
  for (const row of tableRows) {
    projectColWidth = Math.max(projectColWidth, row.project.length);
  }

  function padRight(str, width) {
    return str + " ".repeat(width - str.length);
  }

  function padLeft(str, width) {
    return " ".repeat(width - str.length) + str;
  }

  // ----- Build header -----
  const headers = ["Project", ...activeDays.map(d => dayLabels[d]), "Total"];

  const headerLine =
    padRight(headers[0], projectColWidth) +
    GAP +
    headers.slice(1).map(h => padLeft(h, NUM_WIDTH)).join(GAP);

  // ----- Build rows -----
  const lines = [];
  lines.push(`Weekly Report (${startDate} → ${endDate})`);
  lines.push("");
  lines.push(headerLine);
  lines.push("-".repeat(projectColWidth + (headers.length - 1) * (NUM_WIDTH + GAP.length)));

  for (const row of tableRows) {
    const project = padRight(row.project, projectColWidth);
    const nums = activeDays.map(d => padLeft(String(row[d] || 0), NUM_WIDTH));
    const total = padLeft(String(row.total), NUM_WIDTH);

    lines.push(project + GAP + [...nums, total].join(GAP));
  }

  // ---- Notes ----
  if (notesSection.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const n of notesSection) {
      if (n.notes?.trim()) {
        lines.push(`${n.project}: ${n.notes}`);
      }
    }
  }

  return lines.join("\n");
}



function padLeftHair(str, len) {
  const needed = len - str.length;
  return "\u200A".repeat(needed) + str;
}

function padRightHair(str, len) {
  const needed = len - str.length;
  return str + "\u200A".repeat(needed);
}




async function checkAutoStopTimers() {
  const now = Date.now();
  for (const personId of Object.keys(users)) {
    const u = users[personId];
    if (!u || !u.activeTimers) continue;
    for (const [tid, t] of Object.entries(u.activeTimers)) {
      const started = new Date(t.startedAt).getTime();
      const mins = Math.round((now - started) / 60000);
      if (mins >= AUTO_STOP_MINUTES) {
        await stopTimer(personId, tid, { autoStopped: true });
      }
    }
  }
}

async function stopTimer(personId, timerId, opts = {}) {
  try {
    const u = users[personId] || {};
    const timers = u.activeTimers || {};
    const t = timers[timerId];
    if (!t) {
      console.warn("stopTimer: timer not found", personId, timerId);
      return false;
    }
    const now = Date.now();
    const minutes = Math.max(1, Math.round((now - new Date(t.startedAt).getTime()) / 60000));
    const rec = {
      user: personId,
      project: t.project,
      notes: t.notes || "",
      minutes,
      ts: new Date().toISOString(),
      autoStopped: !!opts.autoStopped
    };
    const arr = loadUserTimecards(personId);
    arr.push(rec);
    saveUserTimecards(personId, arr);

    delete u.activeTimers[timerId];
    persistActiveTimers(personId);

    const roomId = t.roomId || (u && u.roomId);
    if (roomId) {
      const why = opts.autoStopped ? " (auto-stopped after threshold)" : "";
      await sendMessage(roomId, `⏹️ Stopped **${rec.project}** — logged ${rec.minutes} minute(s)${why}.`);
    }

    // refresh timers card if open (only if the stored message id is actually a card)
    // refresh timers card if open (only if the stored message id is actually a card)
    if (u.timersCardMessageId) {
      const fetchRes = await fetchMessageById(u.timersCardMessageId);
      if (fetchRes && fetchRes.ok && fetchRes.json &&
        fetchRes.json.attachments &&
        fetchRes.json.attachments.length &&
        fetchRes.json.personEmail === BOT_EMAIL) {

        const newCard = buildTimersCard(personId);
        await updateMessageById(
          u.timersCardMessageId,
          u.roomId,
          "⏱️ Active timers (refreshed)",
          newCard
        );

      } else {
        console.log("Skipping timersCard update - stored message is not a card or not found.");
      }
    }



    // refresh main card in-place to reflect possible project changes
    if (u.lastCardMessageId) {
      const fetchRes2 = await fetchMessageById(u.lastCardMessageId);
      if (fetchRes2 && fetchRes2.ok && fetchRes2.json && fetchRes2.json.attachments && fetchRes2.json.attachments.length) {
        const updatedCard = buildMainCard(personId);
        await updateMessageById(u.lastCardMessageId, u.roomId, "🕒 Timecard (updated)", updatedCard);
      } else {
        console.log("Skipping main card update - stored message is not a card or not found.");
      }
    }

    return true;
  } catch (err) {
    console.error("stopTimer error:", err && err.stack ? err.stack : err);
    return false;
  }
}

// -------------------- Webhook: messages & attachmentActions --------------------
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== WEBHOOK RECEIVED ===");
    console.log("headers:", req.headers);
    console.log("body:", JSON.stringify(req.body, null, 2));
    res.status(200).send("OK");

    const event = req.body;

    // --- messages (user types in chat) ---
    if (event.resource === "messages" && event.event === "created") {
      const msgId = event.data && event.data.id;
      if (!msgId) return;
      try {
        const resp = await fetch(`${WEBEX_API}/messages/${msgId}`, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } });
        const msg = await resp.json();
        console.log("full message:", JSON.stringify(msg, null, 2));

        // Ignore messages from the bot itself
        if (msg.personEmail === BOT_EMAIL) {
          console.log("Ignoring message from bot itself");
          return;
        }

        const personId = msg.personId;
        const roomId = msg.roomId;
        ensureUser(personId);
        users[personId].roomId = roomId;
        users[personId].personEmail = msg.personEmail || users[personId].personEmail;

        const text = (msg.text || "").trim().toLowerCase();

        if (text === "start") {
          // send or refresh main card and store messageId only if this send contains a card
          const card = buildMainCard(personId);
          const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }];
          const sent = await sendMessage(roomId, "🕐 Quick timecard — please tell me what you're working on:", attachments);
          if (sent && sent.json && sent.json.id) {
            // Verify that the returned message is indeed a card message (has attachments)
            if (sent.json.attachments && sent.json.attachments.length && sent.json.attachments[0].contentType && sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")) {
              if (
                sent.json.attachments &&
                sent.json.attachments.length &&
                sent.json.attachments[0].contentType &&
                sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")
              ) {
                users[personId].lastCardMessageId = sent.json.id;
                console.log("Saved lastCardMessageId:", sent.json.id);
              } else {
                console.log("NOT saving lastCardMessageId — message had no adaptive card.");
              }

              users[personId].roomId = roomId;
              users[personId].toastMainCard = null;
              console.log("Saved lastCardMessageId for", personId, sent.json.id);
            } else {
              console.log("Sent message wasn't a card; not saving lastCardMessageId:", sent.json);
            }
          } else {
            console.warn("Could not send or store lastCardMessageId:", sent && sent.bodyText);
          }
        } else if (text === "report") {
          console.log("Generating weekly report for:", personId);

          const report = generateWeeklyPivotReport(personId);
          const tableText = generateWeeklyPivotTableText(report);

          const card = {
            type: "AdaptiveCard",
            version: "1.3",
            body: [
              {
                type: "TextBlock",
                text: "📊 Weekly Report",
                weight: "Bolder",
                size: "Medium"
              },
              {
                type: "TextBlock",
                text: "```\n" + tableText + "\n```",
                wrap: true
              }
            ],
            actions: [
              {
                type: "Action.Submit",
                title: "🔽 Download CSV",
                data: { action: "download_weekly_csv" }
              },
              {
                type: "Action.Submit",
                title: "🔄 Refresh Report",
                data: { action: "show_weekly_report" }
              }
            ]
          };

          await sendMessage(
            roomId,
            "Weekly Report:",
            [{
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card
            }]
          );

          return;
        } else if (text === "timers" || text === "show timers") {
          const card = buildTimersCard(personId);
          const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }];
          const sent = await sendMessage(roomId, "⏱️ Active timers:", attachments);
          storeIfAdaptiveCard(users[personId], "timersCardMessageId", sent);
          if (sent && sent.json && sent.json.id) {
            if (sent.json.attachments && sent.json.attachments.length && sent.json.attachments[0].contentType && sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")) {
              if (
                sent.json.attachments &&
                sent.json.attachments.length &&
                sent.json.attachments[0].contentType &&
                sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")
              ) {
                users[personId].timersCardMessageId = sent.json.id;
                console.log("Saved timersCardMessageId:", sent.json.id);
              } else {
                console.log("NOT saving timersCardMessageId — message had no adaptive card.");
              }
              console.log("Saved timersCardMessageId for", personId, sent.json.id);
            } else {
              console.log("Sent timers message wasn't a card; not saving timersCardMessageId:", sent.json);
            }
          }
        }
        else if (text === "help") {
          const helpText = `👋 **Timecard Bot Help**

Type **start** to open the timecard adaptive card.
Type **timers** to view and stop active timers.
Type **report** to get your weekly time report.
Type **help** to see this message again.`;
          await sendMessage({ roomId, markdown: helpText });
        } else {
          console.log("Ignoring message text:", text);
          await sendMessage({ roomId, markdown: "❓ Unknown command. Type **help** for more information!" });
        }
      } catch (err) {
        console.error("Error handling message event:", err && err.stack ? err : err);
      }
    }

    // --- attachmentActions (adaptive card submits) ---
    if (event.resource === "attachmentActions" && event.event === "created") {
      const actionId = event.data && event.data.id;
      if (!actionId) return;
      try {
        const resp = await fetch(`${WEBEX_API}/attachment/actions/${actionId}`, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } });
        const action = await resp.json();
        console.log("attachment action payload:", JSON.stringify(action, null, 2));

        const personId = action.personId;
        const roomId = action.roomId;
        ensureUser(personId);
        users[personId].roomId = roomId;

        const inputs = action.inputs || {};
        const actionType = inputs.action || (action.attachment && action.attachment.content && action.attachment.content.data && action.attachment.content.data.action) || null;

        async function refreshMainCard() {
          if (users[personId] && users[personId].lastCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].lastCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updatedCard = buildMainCard(personId);
              await updateMessageById(users[personId].lastCardMessageId, users[personId].roomId, "🕒 Timecard (updated)", updatedCard);
            } else {
              console.log("Skipping refreshMainCard — stored message isn't a card.");
            }
          }
        }

        async function refreshTimersCard() {
          if (users[personId] && users[personId].timersCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].timersCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updated = buildTimersCard(personId);
              await updateMessageById(users[personId].timersCardMessageId, users[personId].roomId, "⏱️ Active timers (updated)", updated);
            } else {
              console.log("Skipping refreshTimersCard — stored message isn't a card.");
            }
          }
        }

        function buildWeeklyReportCard(tableText) {
          return {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.3",
            body: [
              {
                type: "TextBlock",
                text: "📊 Weekly Report",
                weight: "Bolder",
                size: "Medium"
              },
              {
                type: "TextBlock",
                text: "```\n" + tableText + "\n```",
                wrap: true
              }
            ],
            actions: [
              {
                type: "Action.Submit",
                title: "🔄 Refresh Report",
                data: { action: "refresh_report" }
              },
              {
                type: "Action.Submit",
                title: "📁 Download CSV",
                data: { action: "download_weekly_csv" }
              }
            ]
          };
        }



        // ---- start_timer (save project + start timer + auto-refresh main & timers card) ----
        if (actionType === "start_timer") {
          const selected = (inputs.projectDropdown || "").toString().trim();
          const typed = (inputs.newProject || "").toString().trim();
          const project = typed || selected || "Unknown";
          const notes = inputs.notes || "";


          addProjectIfMissing(personId, project);

          // Ensure user object exists
          users[personId] = users[personId] || {};
          users[personId].activeTimers = users[personId].activeTimers || {};


          const u = users[personId];

          // 🔥 1. CHECK DUPLICATE BEFORE starting new timer
          const duplicate = Object.values(u.activeTimers).some(t =>
            t.project === project &&
            (t.notes || "") === (notes || "")
          );

          if (duplicate) {
            users[personId].toastMainCard = `⚠️ Timer for "${project}${notes ? " — " + notes : ""}" is already running.`;
            console.log("DUPLICATE — NOT STARTING NEW TIMER");
            await refreshMainCard();
            return;
          }

          // 🔥 2. No duplicate → create timer
          const tid = makeTimerId();

          u.activeTimers[tid] = {
            project,
            notes,
            startedAt: new Date().toISOString(),
            roomId,
            createdAt: new Date().toISOString()
          };

          persistActiveTimers(personId);

          // Success toast
          users[personId].toastMainCard = `✔ Timer started for ${project}`;
          console.log("TOAST SET:", users[personId].toastMainCard);

          // Auto-clear toast
          setTimeout(() => {
            users[personId].toastMainCard = null;
            console.log("TOAST CLEARED");
          }, 4000);

          // Main UI refresh
          await refreshMainCard();
          await refreshTimersCard();

          return;
        }


        // ---- show_timers / refresh_timers handled via action types ----
        if (actionType === "show_timers") {

          const card = buildTimersCard(personId);
          const attachments = [{
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card
          }];

          // CREATE message (new card)
          const sent = await sendMessage(roomId, "⏱️ Active timers:", attachments);

          // save message id
          if (sent?.json?.id) {
            users[personId].timersCardMessageId = sent.json.id;
            console.log("Saved timersCardMessageId:", sent.json.id);
          }

          return;
        }

        if (actionType === "refresh_timers") {

          const msgId = users[personId].timersCardMessageId;

          if (!msgId) {
            console.log("No timersCardMessageId — falling back to show_timers");

            const card = buildTimersCard(personId);
            const attachments = [{
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card
            }];

            const sent = await sendMessage(roomId, "⏱️ Active timers:", attachments);
            if (sent?.json?.id) users[personId].timersCardMessageId = sent.json.id;

            return;
          }

          const card = buildTimersCard(personId);

          console.log("Updating timers card:", msgId);

          // ✅ FIX: use your wrapper, NOT webex.messages.update
          await updateMessageById(msgId, roomId, "", card);

          return;
        }




        // ---- refresh projects: rebuild and update main card ----
        if (actionType === "refresh_projects") {
          if (users[personId] && users[personId].lastCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].lastCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updatedCard = buildMainCard(personId);
              await updateMessageById(users[personId].lastCardMessageId, users[personId].roomId, "🕒 Timecard (refreshed projects)", updatedCard);
            } else {
              console.log("Skipping refresh_projects — stored message isn't a card.");
            }
          }
          return;
        }

        // ---- manage projects flow ----
        if (actionType === "manage_projects") {
          const manageCard = buildManageProjectsCard(personId);
          const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: manageCard }];
          const sent = await sendMessage(roomId, "🗂️ Manage your projects:", attachments);
          // we don't store this managing card id - it's a separate message
          return;
        }

        if (actionType === "manage_delete_prepare") {
          const raw = (inputs.deleteProjects || "").toString().trim();
          if (!raw) {
            await sendMessage(roomId, "⚠️ No projects selected.");
            return;
          }
          const selected = raw.split(",").map(s => s.trim()).filter(Boolean);
          const confirm = buildConfirmDeleteCard(selected);
          const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: confirm }];
          await sendMessage(roomId, "Please confirm deletion:", attachments);
          return;
        }

        if (actionType === "manage_delete_confirm") {
          const namesStr = (inputs.names || "") || (action.attachment && action.attachment.content && action.attachment.content.data && action.attachment.content.data.names) || "";
          const names = namesStr ? namesStr.split("|").map(x => x.trim()).filter(Boolean) : [];
          if (!names.length) {
            await sendMessage(roomId, "⚠️ No projects found to delete.");
            return;
          }
          const projects = loadUserProjects(personId);
          const toDelete = new Set(names.map(n => n.trim()));
          const kept = projects.filter(p => !toDelete.has(p.name));
          saveUserProjects(personId, kept);

          await sendMessage(roomId, `🗑️ Deleted ${names.length} project(s).`);

          if (users[personId] && users[personId].lastCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].lastCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updated = buildMainCard(personId);
              await updateMessageById(users[personId].lastCardMessageId, users[personId].roomId, "🕒 Timecard (projects updated)", updated);
            } else {
              console.log("Skipping update after delete — stored message isn't a card.");
            }
          }
          return;
        }

        if (actionType === "manage_cancel") {
          if (users[personId] && users[personId].lastCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].lastCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updated = buildMainCard(personId);
              await updateMessageById(users[personId].lastCardMessageId, users[personId].roomId, "🕒 Timecard (cancelled manage)", updated);
            } else {
              console.log("Skipping manage_cancel update — stored message isn't a card.");
            }
          }
          return;
        }

        if (actionType === "stop_selected_timers") {
          const u = users[personId] || {};
          const timers = u.activeTimers || {};
          const selectedKeys = Object.entries(inputs)
            .filter(([k, v]) => k.startsWith("con_") && String(v) === "true")
            .map(([k]) => (u.consolidatedMap && u.consolidatedMap[k]) || null)
            .filter(Boolean);

          if (!selectedKeys.length) {
            users[personId].toastMainCard = "⚠️ No timers selected.";
            await refreshMainCard();
            await refreshTimersCard();
            return;
          }

          let stoppedCount = 0;
          for (const ckey of [...new Set(selectedKeys)]) {
            // find all active timer ids that match this consolidated key
            for (const [tid, t] of Object.entries(timers)) {
              const key = `${t.project}||${(t.notes || "").trim()}`;
              if (key === ckey) {
                // stop this timer (same logic as your stopTimer)
                const now = Date.now();
                const minutes = Math.max(1, Math.round((now - new Date(t.startedAt).getTime()) / 60000));

                const arr = loadUserTimecards(personId);
                arr.push({
                  user: personId,
                  project: t.project,
                  notes: t.notes || "",
                  minutes,
                  ts: new Date().toISOString()
                });
                saveUserTimecards(personId, arr);

                delete timers[tid];
                stoppedCount++;
              }
            }
          }

          persistActiveTimers(personId);

          users[personId].toastMainCard = `✔ Stopped ${stoppedCount} timer(s).`;
          await refreshMainCard();
          await refreshTimersCard();
          return;
        }

        if (actionType === "stop_all_timers") {
          const u = users[personId] || {};
          const timers = u.activeTimers || {};
          const allIds = Object.keys(timers);

          if (allIds.length === 0) {
            users[personId].toastMainCard = "⚠️ No timers running.";
            await refreshMainCard();
            return;
          }

          let stoppedCount = 0;
          for (const tid of allIds) {
            const t = timers[tid];
            if (!t) continue;

            const now = Date.now();
            const minutes = Math.max(1, Math.round((now - new Date(t.startedAt).getTime()) / 60000));

            const arr = loadUserTimecards(personId);
            arr.push({
              user: personId,
              project: t.project,
              notes: t.notes || "",
              minutes,
              ts: new Date().toISOString()
            });
            saveUserTimecards(personId, arr);

            delete timers[tid];
            stoppedCount++;
          }

          persistActiveTimers(personId);

          users[personId].toastMainCard = `✔ Stopped all (${stoppedCount}) timer(s).`;
          await refreshMainCard();
          await refreshTimersCard();

          return;
        }

        if (actionType === "download_weekly_csv") {
          const report = generateWeeklyPivotReport(personId);
          const csv = generateWeeklyPivotCSV(report);
          const buffer = Buffer.from(csv, "utf8");

          await sendFile(roomId, `📊 Weekly Report CSV (${report.startDate} → ${report.endDate})`, buffer, `weekly_report_${report.startDate}_to_${report.endDate}.csv`);

          return;
        }
        if (actionType === "show_weekly_report") {
          console.log("Generating weekly report for:", personId);

          const report = generateWeeklyPivotReport(personId);
          const tableText = generateWeeklyPivotTableText(report);

          const card = {
            type: "AdaptiveCard",
            version: "1.3",
            body: [
              {
                type: "TextBlock",
                text: "📊 Weekly Report",
                weight: "Bolder",
                size: "Medium"
              },
              {
                type: "TextBlock",
                text: "```\n" + tableText + "\n```",
                wrap: true
              }
            ],
            actions: [
              {
                type: "Action.Submit",
                title: "🔽 Download CSV",
                data: { action: "download_weekly_csv" }
              },
              {
                type: "Action.Submit",
                title: "🔄 Refresh Report",
                data: { action: "show_weekly_report" }
              }
            ]
          };

          await sendMessage(
            roomId,
            "Weekly Report:",
            [{
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card
            }]
          );

          if (sent?.json?.id) {
            users[personId].reportCardMessageId = sent.json.id;
            console.log("Saved reportCardMessageId:", sent.json.id);
          }

          return;
        }

        if (actionType === "refresh_report") {

          const msgId = users[personId].reportCardMessageId;

          if (!msgId) {
            console.log("No reportCardMessageId saved — fallback to show_weekly_report");
            return await doShowWeeklyReport(); // your wrapper
          }

          // Re-generate updated report data
          const report = generateWeeklyPivotReport(personId);
          const tableText = generateWeeklyPivotTableText(report);
          const updatedCard = buildWeeklyReportCard(tableText);

          // Update the existing Adaptive Card
          const updated = await updateMessageById(
            msgId,
            roomId,
            "Weekly Report:",
            updatedCard
          );

          if (!updated) {
            console.log("Failed to update report card — fallback");
            return await doShowWeeklyReport();
          }

          console.log("Updated weekly report card:", msgId);
          return;
        }



        if (actionType === "back_to_timecard") {
          if (users[personId] && users[personId].lastCardMessageId) {
            const fetchRes = await fetchMessageById(users[personId].lastCardMessageId);
            if (fetchRes && fetchRes.ok && fetchRes.json && fetchRes.json.attachments && fetchRes.json.attachments.length) {
              const updated = buildMainCard(personId);
              await updateMessageById(users[personId].lastCardMessageId, users[personId].roomId, "🕒 Timecard", updated);
            } else {
              const mainCard = buildMainCard(personId);
              const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: mainCard }];
              const sent = await sendMessage(roomId, "🕒 Timecard", attachments);
              if (sent && sent.json && sent.json.id && sent.json.attachments && sent.json.attachments.length && sent.json.attachments[0].contentType && sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")) {
                if (
                  sent.json.attachments &&
                  sent.json.attachments.length &&
                  sent.json.attachments[0].contentType &&
                  sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")
                ) {
                  users[personId].lastCardMessageId = sent.json.id;
                  console.log("Saved lastCardMessageId:", sent.json.id);
                } else {
                  console.log("NOT saving lastCardMessageId — message had no adaptive card.");
                }

              }
            }
          } else {
            const mainCard = buildMainCard(personId);
            const attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: mainCard }];
            const sent = await sendMessage(roomId, "🕒 Timecard", attachments);
            storeIfAdaptiveCard(users[personId], "lastCardMessageId", sent);
            if (sent && sent.json && sent.json.id && sent.json.attachments && sent.json.attachments.length && sent.json.attachments[0].contentType && sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")) {
              if (
                sent.json.attachments &&
                sent.json.attachments.length &&
                sent.json.attachments[0].contentType &&
                sent.json.attachments[0].contentType.toLowerCase().includes("adaptive")
              ) {
                users[personId].lastCardMessageId = sent.json.id;
                console.log("Saved lastCardMessageId:", sent.json.id);
              } else {
                console.log("NOT saving lastCardMessageId — message had no adaptive card.");
              }

            }
          }
          return;
        }

        // unknown action fallback
        await sendMessage(roomId, "🤔 Action not recognized.");
      } catch (err) {
        console.error("Error handling attachment action:", err && err.stack ? err : err);
      }
    }

  } catch (err) {
    console.error("Webhook handler error:", err && err.stack ? err.stack : err);
    try { res.status(500).send("error"); } catch (e) { }
  }
});

// -------------------- Startup restores --------------------
restoreAllTimersOnStartup();

// periodic check for auto-stop
setInterval(() => {
  checkAutoStopTimers().catch(err => console.error("checkAutoStopTimers failed:", err));
}, 60 * 1000); // every minute

// -------------------- Start server --------------------
app.get("/", (_req, res) => res.send("ok"));
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
