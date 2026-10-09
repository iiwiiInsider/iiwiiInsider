import { mkdir, writeFile } from "node:fs/promises";

const username = "iiwiiInsider";
const apiBase = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${username}-profile-activity`,
};

if (process.env.PROFILE_GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.PROFILE_GITHUB_TOKEN}`;
}

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${detail}`);
  }
  return response.json();
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shortDate(value) {
  if (!value) return "No commits yet";
  return new Date(value).toISOString().slice(0, 10);
}

function statusLabel(run) {
  if (run?.unavailable) return "UNAVAILABLE";
  if (!run) return "NO RUNS";
  if (run.status !== "completed") return run.status.replaceAll("_", " ").toUpperCase();
  return (run.conclusion ?? "completed").replaceAll("_", " ").toUpperCase();
}

async function getLatestForRepository(repo) {
  const base = `/repos/${username}/${encodeURIComponent(repo.name)}`;
  const [commits, runs] = await Promise.all([
    github(`${base}/commits?per_page=1`).catch((error) => {
      if (error.message.includes("GitHub API 409")) return [];
      throw error;
    }),
    github(`${base}/actions/runs?per_page=1&exclude_pull_requests=true`).catch((error) => {
      if (error.message.includes("GitHub API 404")) {
        return { workflow_runs: [], unavailable: true };
      }
      throw error;
    }),
  ]);

  const commit = commits[0];
  const run = runs.workflow_runs[0];
  return {
    name: repo.name,
    url: repo.html_url,
    commitUrl: commit?.html_url ?? repo.html_url,
    commitDate: commit?.commit?.author?.date ?? commit?.commit?.committer?.date,
    commitMessage: commit?.commit?.message?.split("\n")[0] ?? "No commits yet",
    sha: commit?.sha?.slice(0, 7) ?? "",
    status: statusLabel(runs.unavailable ? { unavailable: true } : run),
    statusColor: runs.unavailable
      ? "#8b949e"
      : run
      ? run.status !== "completed"
        ? "#d29922"
        : run.conclusion === "success"
          ? "#3fb950"
          : run.conclusion === "failure"
            ? "#f85149"
            : "#8b949e"
      : "#8b949e",
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

async function getRecentPublicEvents() {
  const events = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await github(
      `/users/${username}/events/public?per_page=100&page=${page}`,
    );
    events.push(...batch);
    if (batch.length < 100) break;
  }
  return events;
}

function dashboardSvg(repositories) {
  const width = 960;
  const rowHeight = 48;
  const top = 90;
  const height = top + Math.max(repositories.length, 1) * rowHeight + 24;
  const rows = repositories.length
    ? repositories
        .map((repo, index) => {
          const y = top + index * rowHeight;
          const message =
            repo.commitMessage.length > 44
              ? `${repo.commitMessage.slice(0, 41)}...`
              : repo.commitMessage;
          return `
    <a href="${xml(repo.url)}">
      <rect x="16" y="${y}" width="928" height="42" rx="8" fill="#161b22"/>
      <text x="32" y="${y + 17}" class="name">${xml(repo.name)}</text>
    </a>
    <a href="${xml(repo.commitUrl)}">
      <text x="32" y="${y + 34}" class="detail">${xml(repo.sha)} ${xml(message)}</text>
    </a>
    <text x="604" y="${y + 26}" class="detail">${xml(shortDate(repo.commitDate))}</text>
    <circle cx="790" cy="${y + 21}" r="5" fill="${repo.statusColor}" class="status-dot"/>
    <a href="${xml(repo.url)}/actions">
      <text x="804" y="${y + 26}" class="status" fill="${repo.statusColor}">${xml(repo.status)}</text>
    </a>`;
        })
        .join("")
    : `<text x="32" y="${top + 26}" class="detail">No public repositories found.</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Public repository activity</title>
  <desc id="description">Latest commits and GitHub Actions status for public repositories.</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .heading { fill: #f0f6fc; font-size: 22px; font-weight: 700; }
    .column { fill: #8b949e; font-size: 12px; font-weight: 600; letter-spacing: .08em; }
    .name { fill: #58a6ff; font-size: 14px; font-weight: 700; }
    .detail { fill: #8b949e; font-size: 12px; }
    .status { font-size: 11px; font-weight: 700; }
    .status-dot { animation: blink 1.8s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .35; } }
    a { text-decoration: none; }
  </style>
  <rect width="100%" height="100%" rx="12" fill="#0d1117"/>
  <text x="24" y="38" class="heading">REPOSITORY ACTIVITY // ${repositories.length} PUBLIC REPOS</text>
  <text x="32" y="70" class="column">REPOSITORY / LATEST COMMIT</text>
  <text x="604" y="70" class="column">DATE</text>
  <text x="790" y="70" class="column">LATEST ACTION</text>
  ${rows}
</svg>
`;
}

function commitPulseSvg(events) {
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (29 - index));
    return date.toISOString().slice(0, 10);
  });
  const counts = new Map(days.map((day) => [day, 0]));

  for (const event of events) {
    if (event.type !== "PushEvent") continue;
    const day = event.created_at.slice(0, 10);
    if (counts.has(day)) {
      counts.set(day, counts.get(day) + Math.max(event.payload?.commits?.length ?? 0, 1));
    }
  }

  const values = days.map((day) => counts.get(day));
  const max = Math.max(...values, 1);
  const xStart = 36;
  const xStep = 29;
  const baseline = 142;
  const points = values.map((value, index) => {
    const x = xStart + index * xStep;
    const y = baseline - (value / max) * 90;
    return `${x},${y.toFixed(1)}`;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  const labels = values
    .map((value, index) => {
      const x = xStart + index * xStep;
      const barHeight = Math.max((value / max) * 74, value ? 4 : 1);
      return `<rect x="${x - 5}" y="${baseline - barHeight}" width="10" height="${barHeight}" rx="3" fill="${value ? "#238636" : "#21262d"}" opacity="${value ? ".8" : ".65"}"/>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="940" height="210" viewBox="0 0 940 210" role="img" aria-labelledby="title description">
  <title id="title">Animated commit activity pulse</title>
  <desc id="description">${total} public commits in the last 30 days.</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .title { fill: #f0f6fc; font-size: 17px; font-weight: 700; }
    .muted { fill: #8b949e; font-size: 11px; }
    .pulse { fill: none; stroke: #3fb950; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 9 8; animation: flow 6s linear infinite; }
    .glow { fill: none; stroke: #3fb950; stroke-width: 8; opacity: .16; }
    .dot { fill: #3fb950; animation: breathe 1.6s ease-in-out infinite; transform-origin: center; }
    @keyframes flow { to { stroke-dashoffset: -68; } }
    @keyframes breathe { 50% { opacity: .45; transform: scale(.72); } }
  </style>
  <rect width="100%" height="100%" rx="12" fill="#0d1117"/>
  <text x="24" y="32" class="title">COMMIT PULSE // ${total} PUBLIC COMMITS IN 30 DAYS</text>
  <text x="24" y="51" class="muted">Daily public push activity · UTC</text>
  ${labels}
  <polyline class="glow" points="${points.join(" ")}"/>
  <polyline class="pulse" points="${points.join(" ")}"/>
  <circle cx="${xStart + 29 * xStep}" cy="${points.at(-1).split(",")[1]}" r="5" class="dot"/>
  <text x="${xStart}" y="180" class="muted">${xml(days[0])}</text>
  <text x="${xStart + 22 * xStep}" y="180" class="muted">${xml(days[22])}</text>
  <text x="864" y="180" class="muted">${xml(days[29])}</text>
</svg>
`;
}

async function main() {
  const repositories = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github(
      `/users/${username}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );
    repositories.push(...batch.filter((repo) => !repo.private));
    if (batch.length < 100) break;
  }

  const selected = repositories.slice(0, 25);
  const activity = await mapWithConcurrency(selected, 5, getLatestForRepository);
  const events = await getRecentPublicEvents();

  await mkdir("assets", { recursive: true });
  await Promise.all([
    writeFile("assets/repo-dashboard.svg", dashboardSvg(activity)),
    writeFile("assets/commit-pulse.svg", commitPulseSvg(events)),
  ]);

  console.log(
    `Updated activity graphics for ${activity.length} repositories and ${events.length} recent public events.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
