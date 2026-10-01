const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const store = require("./store");

// The public site (gci-events.netlify.app) is a static copy of site/index.html
// with the upcoming events baked into its events-data JSON block. Publishing
// rebuilds that page from the current events and pushes it straight to
// Netlify's deploy API — no local machine or scheduled task involved.
const TEMPLATE = path.join(__dirname, "..", "site", "index.html");
const API = "https://api.netlify.com/api/v1";
const DEFAULT_SITE_ID = "ce0e3b72-63ce-4f79-ba01-3941ab2205b0";
const EVENTS_BLOCK = /(<script type="application\/json" id="events-data">)[\s\S]*?(<\/script>)/;

// "Today" as the Institute sees it — Render's clock is UTC, which would drop
// a same-day event in the evening Israel time.
function todayInIsrael() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

function publicEvents() {
  const today = todayInIsrael();
  return store.listEvents()
    .filter((e) => e.date >= today)
    .sort((a, b) => (a.date + (a.startTime || "")).localeCompare(b.date + (b.startTime || "")))
    .map((e) => ({
      title: e.title ?? null,
      type: e.type,
      date: e.date,
      startTime: e.startTime,
      endTime: e.endTime,
      capacity: e.capacity ?? null,
      price: e.price ?? null,
      description: e.description,
      imageUrl: e.imageFile ? "images/" + e.imageFile : null,
      registrationUrl: e.registrationUrl ?? null,
    }));
}

function buildFiles() {
  const events = publicEvents();
  const template = fs.readFileSync(TEMPLATE, "utf8");
  if (!EVENTS_BLOCK.test(template)) throw new Error("site/index.html is missing its events-data block");
  // Escape "</" so an event description can never close the <script> early.
  const json = JSON.stringify(events, null, 2).replace(/<\//g, "<\\/");
  const html = template.replace(EVENTS_BLOCK, (_m, open, close) => open + "\n" + json + "\n" + close);

  const files = { "/index.html": Buffer.from(html, "utf8") };
  for (const e of events) {
    if (!e.imageUrl) continue;
    const imagePath = path.join(store.IMAGES_DIR, path.basename(e.imageUrl));
    if (fs.existsSync(imagePath)) files["/" + e.imageUrl] = fs.readFileSync(imagePath);
  }
  return { files, eventCount: events.length };
}

async function api(method, url, token, body, contentType) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": contentType || "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Netlify ${method} ${url} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Digest deploy: send the sha1 of every file, upload only the ones Netlify
// doesn't already have, then wait for the deploy to go live. The file list is
// the whole site — anything not listed (e.g. old images) drops off.
async function publishSite() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const err = new Error("NETLIFY_AUTH_TOKEN isn't set on the Render service, so the site can't be published yet.");
    err.status = 503;
    throw err;
  }
  const siteId = process.env.NETLIFY_SITE_ID || DEFAULT_SITE_ID;
  const { files, eventCount } = buildFiles();

  const digests = {};
  const byDigest = {};
  for (const [filePath, buf] of Object.entries(files)) {
    const sha = crypto.createHash("sha1").update(buf).digest("hex");
    digests[filePath] = sha;
    byDigest[sha] = filePath;
  }

  const deploy = await api("POST", `/sites/${siteId}/deploys`, token, JSON.stringify({ files: digests }));
  for (const sha of deploy.required || []) {
    const filePath = byDigest[sha];
    await api("PUT", `/deploys/${deploy.id}/files${encodeURI(filePath)}`, token, files[filePath], "application/octet-stream");
  }

  let state = deploy.state;
  for (let i = 0; i < 30 && state !== "ready" && state !== "error"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    state = (await api("GET", `/deploys/${deploy.id}`, token)).state;
  }
  if (state === "error") throw new Error("Netlify reported an error while processing the deploy.");

  return { eventCount, state, deployId: deploy.id };
}

module.exports = { publishSite };
