const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");

const store = require("./lib/store");
const git = require("./lib/git");
const { basicAuth } = require("./lib/auth");

const ROOT = __dirname;
const PORT = process.env.PORT || 4000;

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

// Every admin write is submitted as multipart/form-data (so the optional
// image file and the text fields travel in one request) — multer parses
// req.body for those routes itself, so no express.json/urlencoded needed.
app.use("/images", express.static(store.IMAGES_DIR));

app.get("/", function (_req, res) {
  res.sendFile(path.join(ROOT, "views", "public.html"));
});

app.get("/admin", basicAuth, function (_req, res) {
  res.sendFile(path.join(ROOT, "views", "admin.html"));
});

// Reads are public — this is the same data the public calendar shows.
app.get("/api/events", function (_req, res) {
  res.json(store.listEvents());
});

app.post("/api/events", basicAuth, upload.single("image"), async function (req, res) {
  try {
    var body = req.body || {};
    var imageFile = null;
    if (req.file) imageFile = store.saveImageBuffer(req.file.buffer, req.file.mimetype);
    var fields = Object.assign({}, body, { imageFile: imageFile });
    var repeatFrequency = body.repeatFrequency || "none";

    if (repeatFrequency !== "none") {
      var created = store.createEventSeries(fields, repeatFrequency, body.repeatCount);
      var seriesPaths = ["data/events.json"];
      if (imageFile) seriesPaths.push("public/images/" + imageFile);
      var seriesResult = await git.saveAndPublish(seriesPaths, "Add event series: " + created[0].type + " starting " + created[0].date + " (x" + created.length + " " + repeatFrequency + ")");
      if (!seriesResult.ok) return res.status(207).json({ events: created, warning: "Saved locally, but publishing to GitHub failed — this may not survive a restart.", steps: seriesResult.steps });
      return res.status(201).json({ events: created });
    }

    var event = store.createEvent(fields);
    var publishPaths = ["data/events.json"];
    if (imageFile) publishPaths.push("public/images/" + imageFile);
    var result = await git.saveAndPublish(publishPaths, "Add event: " + event.type + " " + event.date);
    if (!result.ok) return res.status(207).json({ event: event, warning: "Saved locally, but publishing to GitHub failed — this may not survive a restart.", steps: result.steps });
    res.status(201).json({ event: event });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not create event" });
  }
});

app.patch("/api/events/:id", basicAuth, upload.single("image"), async function (req, res) {
  try {
    var imageFile = null;
    if (req.file) imageFile = store.saveImageBuffer(req.file.buffer, req.file.mimetype);
    var body = req.body || {};
    var fields = Object.assign({}, body, {
      imageFile: imageFile,
      removeImage: body.removeImage === "true",
    });
    var result1 = store.updateEvent(req.params.id, fields);
    var publishPaths = ["data/events.json"];
    if (imageFile) publishPaths.push("public/images/" + imageFile);
    if (result1.replacedImageFile) store.deleteImageFile(result1.replacedImageFile);
    var result = await git.saveAndPublish(publishPaths, "Update event: " + result1.event.type + " " + result1.event.date);
    if (!result.ok) return res.status(207).json({ event: result1.event, warning: "Saved locally, but publishing to GitHub failed — this may not survive a restart.", steps: result.steps });
    res.json({ event: result1.event });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not update event" });
  }
});

app.delete("/api/events/:id", basicAuth, async function (req, res) {
  try {
    var removed = store.deleteEvent(req.params.id);
    if (removed.imageFile) store.deleteImageFile(removed.imageFile);
    var result = await git.saveAndPublish(["data/events.json", "public/images"], "Delete event: " + removed.type + " " + removed.date);
    if (!result.ok) return res.status(207).json({ warning: "Deleted locally, but publishing to GitHub failed — this may not survive a restart.", steps: result.steps });
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not delete event" });
  }
});

app.listen(PORT, function () {
  console.log("GCI Events server running on port " + PORT);
});
