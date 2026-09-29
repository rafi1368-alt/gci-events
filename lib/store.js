const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "events.json");
const IMAGES_DIR = path.join(ROOT, "public", "images");

const VALID_TYPES = ["workshop", "demo"];
const REPEAT_FREQUENCIES = ["weekly", "biweekly", "monthly"];
const MAX_REPEAT_COUNT = 52; // safety cap regardless of the date range given

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function dateToStr(d) {
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function parseDateUTC(dateStr) {
  const parts = dateStr.split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function addMonthsToDateStr(dateStr, months) {
  const parts = dateStr.split("-").map(Number);
  const y = parts[0], m = parts[1] - 1, d = parts[2];
  const targetMonthIndex = m + months;
  // Clamp to the target month's last day instead of letting e.g. Jan 31 + 1
  // month silently roll into early March.
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return dateToStr(new Date(Date.UTC(y, targetMonthIndex, day)));
}

// Every date in [startDateStr, endDateStr] that falls on one of `weekdays`
// (0=Sun..6=Sat), stepping every `stepWeeks` weeks from the week containing
// the start date.
function generateWeeklySeries(startDateStr, endDateStr, stepWeeks, weekdays) {
  const start = parseDateUTC(startDateStr);
  const end = parseDateUTC(endDateStr);
  const weekStart = new Date(start);
  weekStart.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const dates = [];
  let weekCursor = new Date(weekStart);
  let guard = 0;
  while (weekCursor <= end && dates.length < MAX_REPEAT_COUNT && guard < MAX_REPEAT_COUNT * 2) {
    guard++;
    for (const wd of weekdays) {
      const occ = new Date(weekCursor);
      occ.setUTCDate(weekCursor.getUTCDate() + wd);
      if (occ >= start && occ <= end) dates.push(dateToStr(occ));
    }
    weekCursor.setUTCDate(weekCursor.getUTCDate() + 7 * stepWeeks);
  }
  dates.sort();
  return dates.slice(0, MAX_REPEAT_COUNT);
}

function generateMonthlySeries(startDateStr, endDateStr) {
  const endTime = parseDateUTC(endDateStr).getTime();
  const dates = [];
  for (let i = 0; i < MAX_REPEAT_COUNT; i++) {
    const occ = addMonthsToDateStr(startDateStr, i);
    if (parseDateUTC(occ).getTime() > endTime) break;
    dates.push(occ);
  }
  return dates;
}

function readEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function writeEvents(events) {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2) + "\n", "utf8");
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function parseCapacity(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: null, error: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { value: null, error: "total participants must be a positive whole number" };
  return { value: n, error: null };
}

function validate(fields) {
  const errors = [];
  if (!fields.title || !fields.title.trim()) errors.push("event name is required");
  if (VALID_TYPES.indexOf(fields.type) === -1) errors.push("type must be one of: " + VALID_TYPES.join(", "));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date || "")) errors.push("date is required (YYYY-MM-DD)");
  if (!/^\d{2}:\d{2}$/.test(fields.startTime || "")) errors.push("start time is required");
  if (!/^\d{2}:\d{2}$/.test(fields.endTime || "")) errors.push("end time is required");
  if (!fields.description || !fields.description.trim()) errors.push("description is required");
  const capacity = parseCapacity(fields.capacity);
  if (capacity.error) errors.push(capacity.error);
  if (fields.registrationUrl) {
    try {
      const u = new URL(fields.registrationUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") errors.push("registration link must be http(s)");
    } catch (e) {
      errors.push("registration link is not a valid URL");
    }
  }
  return { errors, capacity: capacity.value };
}

function listEvents() {
  return readEvents().sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}

function getEvent(id) {
  return readEvents().find(function (e) {
    return e.id === id;
  });
}

function createEvent(fields) {
  const { errors, capacity } = validate(fields);
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }
  const events = readEvents();
  const now = new Date().toISOString();
  const event = {
    id: newId(),
    title: fields.title.trim(),
    type: fields.type,
    date: fields.date,
    startTime: fields.startTime,
    endTime: fields.endTime,
    capacity: capacity,
    description: fields.description.trim(),
    imageFile: fields.imageFile || null,
    registrationUrl: fields.registrationUrl || null,
    createdAt: now,
    updatedAt: now,
  };
  events.push(event);
  writeEvents(events);
  return event;
}

// Creates one independent event document per occurrence, sharing a seriesId.
// Each occurrence is a normal event afterward — editing or deleting one never
// touches the others, which is the simplest correct behavior for what was
// asked (no "edit whole series" semantics needed here).
//
// frequency: "weekly" | "biweekly" | "monthly"
// weekdays: array of 0(Sun)-6(Sat), only meaningful for weekly/biweekly —
//   defaults to the start date's own weekday when empty.
// endDateStr: "YYYY-MM-DD", inclusive, required.
function createEventSeries(fields, frequency, weekdays, endDateStr) {
  const { errors, capacity } = validate(fields);
  if (REPEAT_FREQUENCIES.indexOf(frequency) === -1) {
    errors.push("repeat frequency must be one of: " + REPEAT_FREQUENCIES.join(", "));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateStr || "")) {
    errors.push("an end date is required for a recurring event");
  } else if (fields.date && endDateStr < fields.date) {
    errors.push("the end date must be on or after the start date");
  }
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }

  let dates;
  if (frequency === "monthly") {
    dates = generateMonthlySeries(fields.date, endDateStr);
  } else {
    const step = frequency === "biweekly" ? 2 : 1;
    const wds = Array.isArray(weekdays) && weekdays.length ? weekdays : [parseDateUTC(fields.date).getUTCDay()];
    dates = generateWeeklySeries(fields.date, endDateStr, step, wds);
  }
  if (!dates.length) {
    const err = new Error("no occurrences fall between the start and end date");
    err.status = 400;
    throw err;
  }

  const events = readEvents();
  const now = new Date().toISOString();
  const seriesId = newId();
  const created = [];
  dates.forEach(function (date) {
    const event = {
      id: newId(),
      seriesId: seriesId,
      title: fields.title.trim(),
      type: fields.type,
      date: date,
      startTime: fields.startTime,
      endTime: fields.endTime,
      capacity: capacity,
      description: fields.description.trim(),
      imageFile: fields.imageFile || null,
      registrationUrl: fields.registrationUrl || null,
      createdAt: now,
      updatedAt: now,
    };
    events.push(event);
    created.push(event);
  });
  writeEvents(events);
  return created;
}

function updateEvent(id, fields) {
  const { errors, capacity } = validate(fields);
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }
  const events = readEvents();
  const idx = events.findIndex(function (e) {
    return e.id === id;
  });
  if (idx === -1) {
    const err = new Error("Event not found");
    err.status = 404;
    throw err;
  }
  const previousImage = events[idx].imageFile;
  const event = Object.assign({}, events[idx], {
    title: fields.title.trim(),
    type: fields.type,
    date: fields.date,
    startTime: fields.startTime,
    endTime: fields.endTime,
    capacity: capacity,
    description: fields.description.trim(),
    registrationUrl: fields.registrationUrl || null,
    updatedAt: new Date().toISOString(),
  });
  if (fields.removeImage) {
    event.imageFile = null;
  } else if (fields.imageFile) {
    event.imageFile = fields.imageFile;
  }
  events[idx] = event;
  writeEvents(events);
  return { event: event, replacedImageFile: (fields.imageFile || fields.removeImage) ? previousImage : null };
}

function deleteEvent(id) {
  const events = readEvents();
  const idx = events.findIndex(function (e) {
    return e.id === id;
  });
  if (idx === -1) {
    const err = new Error("Event not found");
    err.status = 404;
    throw err;
  }
  const removed = events.splice(idx, 1)[0];
  writeEvents(events);
  return removed;
}

function saveImageBuffer(buffer, contentType) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[contentType] || "jpg";
  const filename = newId() + "." + ext;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
  return filename;
}

function deleteImageFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(IMAGES_DIR, filename));
  } catch (e) {
    // best-effort — an already-missing file is not an error here
  }
}

module.exports = {
  VALID_TYPES,
  REPEAT_FREQUENCIES,
  MAX_REPEAT_COUNT,
  IMAGES_DIR,
  EVENTS_FILE,
  listEvents,
  getEvent,
  createEvent,
  createEventSeries,
  updateEvent,
  deleteEvent,
  saveImageBuffer,
  deleteImageFile,
};
