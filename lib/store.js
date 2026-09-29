const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "events.json");
const IMAGES_DIR = path.join(ROOT, "public", "images");

const VALID_TYPES = ["workshop", "demo", "farming"];

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

function validate(fields) {
  const errors = [];
  if (VALID_TYPES.indexOf(fields.type) === -1) errors.push("type must be workshop, demo or farming");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date || "")) errors.push("date is required (YYYY-MM-DD)");
  if (!/^\d{2}:\d{2}$/.test(fields.startTime || "")) errors.push("start time is required");
  if (!/^\d{2}:\d{2}$/.test(fields.endTime || "")) errors.push("end time is required");
  if (!fields.description || !fields.description.trim()) errors.push("description is required");
  if (fields.registrationUrl) {
    try {
      const u = new URL(fields.registrationUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") errors.push("registration link must be http(s)");
    } catch (e) {
      errors.push("registration link is not a valid URL");
    }
  }
  return errors;
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
  const errors = validate(fields);
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }
  const events = readEvents();
  const now = new Date().toISOString();
  const event = {
    id: newId(),
    type: fields.type,
    date: fields.date,
    startTime: fields.startTime,
    endTime: fields.endTime,
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

function updateEvent(id, fields) {
  const errors = validate(fields);
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
    type: fields.type,
    date: fields.date,
    startTime: fields.startTime,
    endTime: fields.endTime,
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
  IMAGES_DIR,
  EVENTS_FILE,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  saveImageBuffer,
  deleteImageFile,
};
