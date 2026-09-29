const { execFile } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: ROOT, shell: true }, (error, stdout, stderr) => {
      resolve({
        command: `${command} ${args.join(" ")}`,
        ok: !error,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
      });
    });
  });
}

// Render's disk is ephemeral across restarts/redeploys — the repo checkout is
// the only thing that survives. Every write to data/events.json or
// public/images must be committed and pushed immediately, or it's lost the
// next time this service redeploys or restarts.
async function ensureGitIdentity() {
  await run("git", ["config", "user.email", process.env.GIT_AUTHOR_EMAIL || "admin@gci-events.local"]);
  await run("git", ["config", "user.name", process.env.GIT_AUTHOR_NAME || "GCI Events Admin"]);
}

async function resolveRepoAndBranch() {
  let ownerRepo = process.env.GITHUB_REPO;
  let remoteResult;
  if (!ownerRepo) {
    remoteResult = await run("git", ["remote", "get-url", "origin"]);
    const match = remoteResult.stdout.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);
    ownerRepo = match && match[1];
  }
  if (!ownerRepo) {
    return {
      error: `Could not determine the GitHub owner/repo from the origin remote (got: "${remoteResult ? remoteResult.stdout : ""}" ${remoteResult ? remoteResult.stderr : ""}). Set GITHUB_REPO=owner/repo to bypass this.`,
    };
  }
  const branchResult = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detectedBranch = branchResult.stdout.trim();
  const branch = process.env.GIT_PUBLISH_BRANCH || (detectedBranch && detectedBranch !== "HEAD" ? detectedBranch : "main");
  return { ownerRepo, branch };
}

async function commitStep(message) {
  const args = ["commit", "-m", JSON.stringify(message || "Update GCI events")];
  const result = await run("git", args);
  if (!result.ok && /Please tell me who you are|unable to auto-detect/i.test(result.stdout + result.stderr)) {
    await ensureGitIdentity();
    return run("git", args);
  }
  return result;
}

async function pushStep() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return run("git", ["push"]);
  }

  const { ownerRepo, branch, error } = await resolveRepoAndBranch();
  if (error) {
    return { command: "git push", ok: false, stdout: "", stderr: error };
  }

  const authedUrl = `https://x-access-token:${token}@github.com/${ownerRepo}.git`;
  const scrub = (s) => s.split(token).join("***");

  const fetchResult = await run("git", ["fetch", authedUrl, branch]);
  if (fetchResult.ok) {
    const rebaseResult = await run("git", ["rebase", "FETCH_HEAD"]);
    if (!rebaseResult.ok) {
      await run("git", ["rebase", "--abort"]);
      return {
        command: "git rebase (onto latest GitHub content)",
        ok: false,
        stdout: scrub(rebaseResult.stdout),
        stderr: `${scrub(rebaseResult.stderr)}\n\nThis change conflicts with something already saved since this page loaded. Reload and try again.`,
      };
    }
  }

  const result = await run("git", ["push", authedUrl, `HEAD:${branch}`]);
  return {
    command: "git push (using GITHUB_TOKEN)",
    ok: result.ok,
    stdout: scrub(result.stdout),
    stderr: scrub(result.stderr),
  };
}

// Commits every currently-staged/unstaged change under the given paths and
// pushes it. Returns {ok, steps} — steps is the raw command log, useful for
// surfacing an error to the admin UI.
async function saveAndPublish(paths, message) {
  const steps = [];
  steps.push(await run("git", ["add", ...paths]));
  const commit = await commitStep(message);
  steps.push(commit);
  // "nothing to commit" isn't a real failure — the working tree already
  // matched what we meant to save (e.g. a retried request).
  const nothingToCommit = /nothing to commit/i.test(commit.stdout + commit.stderr);
  if (!commit.ok && !nothingToCommit) {
    return { ok: false, steps };
  }
  const push = await pushStep();
  steps.push(push);
  return { ok: push.ok || nothingToCommit, steps };
}

module.exports = { saveAndPublish, run };
