import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

async function fetchText(url, source) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, application/rss+xml, application/xml, text/xml",
      "User-Agent": `${username}-profile-activity`,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${source} returned ${response.status}: ${detail}`);
  }
  return response.text();
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value) {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) =>
      String.fromCodePoint(
        code[0].toLowerCase() === "x"
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10),
      ),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export async function getLatestBtcDailyCandle() {
  const text = await fetchText(
    "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440",
    "Kraken BTC/USD daily candles",
  );
  const payload = JSON.parse(text);
  if (payload.error?.length) {
    throw new Error(`Kraken BTC/USD daily candles failed: ${payload.error.join(", ")}`);
  }

  const resultKey = Object.keys(payload.result ?? {}).find((key) => key !== "last");
  const candles = resultKey ? payload.result[resultKey] : [];
  const candle = candles
    .filter((entry) => Array.isArray(entry) && (Number(entry[0]) + 86400) * 1000 <= Date.now())
    .at(-1);
  if (!candle) {
    throw new Error("Kraken did not return a completed BTC/USD daily candle.");
  }

  return {
    date: new Date(Number(candle[0]) * 1000).toISOString().slice(0, 10),
    open: Number(candle[1]),
    close: Number(candle[4]),
  };
}

async function getLatestBitcoinNews() {
  const feedUrl =
    "https://news.google.com/rss/search?q=bitcoin&hl=en-US&gl=US&ceid=US:en";
  const feed = await fetchText(feedUrl, "Google News Bitcoin RSS");
  const articles = [...feed.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(
    ([, item]) => {
      const getTag = (tag) => {
        const match = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return match ? decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
      };
      return {
        title: getTag("title"),
        url: getTag("link"),
        source: getTag("source"),
        publishedAt: getTag("pubDate"),
      };
    },
  );

  return articles
    .filter((article) => article.title && article.url)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] ?? null;
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

async function getRepositoryLanguages(repo) {
  return github(`/repos/${username}/${encodeURIComponent(repo.name)}/languages`);
}

export function aggregateLanguages(repositoryLanguages) {
  const totals = new Map();
  for (const languages of repositoryLanguages) {
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }

  const languages = [...totals.entries()]
    .filter(([, bytes]) => bytes > 0)
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const totalBytes = languages.reduce((sum, language) => sum + language.bytes, 0);
  if (!totalBytes) return [];

  const tenths = languages.map((language) => {
    const exactTenths = (language.bytes / totalBytes) * 1000;
    return {
      ...language,
      tenths: Math.floor(exactTenths),
      remainder: exactTenths - Math.floor(exactTenths),
    };
  });
  const remainingTenths = 1000 - tenths.reduce((sum, language) => sum + language.tenths, 0);
  const remainderOrder = [...tenths].sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < remainingTenths; index++) {
    remainderOrder[index].tenths++;
  }

  return tenths.map(({ name, bytes, tenths: share }) => ({
    name,
    bytes,
    percentage: share / 10,
  }));
}

export function languageDashboardSvg(languages, repositoryCount) {
  const width = 960;
  const rowHeight = 38;
  const columns = 2;
  const rowCount = Math.ceil(languages.length / columns);
  const height = 144 + Math.max(rowCount, 1) * rowHeight + 24;
  const colors = {
    "C#": "#178600",
    CSS: "#563d7c",
    Dockerfile: "#384d54",
    Go: "#00add8",
    HTML: "#e34c26",
    Java: "#b07219",
    JavaScript: "#f1e05a",
    Jupyter: "#da5b0b",
    Kotlin: "#a97bff",
    PHP: "#4f5d95",
    Python: "#3572a5",
    Ruby: "#701516",
    Rust: "#dea584",
    Shell: "#89e051",
    Swift: "#f05138",
    TypeScript: "#3178c6",
  };
  const palette = ["#58a6ff", "#bc8cff", "#f778ba", "#ffa657", "#3fb950", "#79c0ff"];
  const totalBytes = languages.reduce((sum, language) => sum + language.bytes, 0);
  let x = 24;
  const barWidth = 912;
  const segments = languages
    .map((language, index) => {
      const segmentWidth =
        index === languages.length - 1
          ? 24 + barWidth - x
          : (language.bytes / totalBytes) * barWidth;
      const segment = `<rect x="${x.toFixed(2)}" y="94" width="${segmentWidth.toFixed(2)}" height="16" fill="${colors[language.name] ?? palette[index % palette.length]}"/>`;
      x += segmentWidth;
      return segment;
    })
    .join("");
  const rows = languages.length
    ? languages
        .map((language, index) => {
          const column = Math.floor(index / rowCount);
          const row = index % rowCount;
          const left = 32 + column * 464;
          const y = 142 + row * rowHeight;
          const color = colors[language.name] ?? palette[index % palette.length];
          const label = `${language.percentage.toFixed(1)}%`;
          const byteLabel =
            language.bytes >= 1_000_000
              ? `${(language.bytes / 1_000_000).toFixed(1)} MB`
              : language.bytes >= 1000
                ? `${(language.bytes / 1000).toFixed(1)} KB`
                : `${language.bytes} B`;
          return `
    <circle cx="${left}" cy="${y - 4}" r="5" fill="${color}"/>
    <text x="${left + 14}" y="${y}" class="language">${xml(language.name)}</text>
    <text x="${left + 340}" y="${y}" class="percentage">${label}</text>
    <text x="${left + 390}" y="${y}" class="bytes">${byteLabel}</text>`;
        })
        .join("")
    : `<text x="32" y="150" class="muted">Waiting for the profile workflow to calculate language percentages.</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Programming language usage across public repositories</title>
  <desc id="description">${languages.length ? `All ${languages.length} detected languages across ${repositoryCount} public repositories, totaling 100 percent by GitHub-reported language bytes.` : "Language data has not been generated yet."}</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .heading { fill: #f0f6fc; font-size: 19px; font-weight: 700; }
    .muted, .bytes { fill: #8b949e; font-size: 11px; }
    .language { fill: #c9d1d9; font-size: 13px; }
    .percentage { fill: #f0f6fc; font-size: 13px; font-weight: 700; }
  </style>
  <rect width="100%" height="100%" rx="12" fill="#0d1117"/>
  <text x="24" y="36" class="heading">LANGUAGE MIX // ${languages.length ? "100%" : "AWAITING DATA"}</text>
  <text x="24" y="61" class="muted">${languages.length ? `All ${languages.length} detected languages · ${repositoryCount} public repositories · share of GitHub-reported code bytes` : "Language shares will appear after the profile workflow fetches GitHub's byte totals."}</text>
  <clipPath id="bar-clip"><rect x="24" y="94" width="912" height="16" rx="8"/></clipPath>
  <g clip-path="url(#bar-clip)">${segments}</g>
  ${rows}
</svg>
`;
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

function recentUtcDays(count = 30) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (count - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

async function getOwnedPrivateRepositories() {
  if (process.env.INCLUDE_PRIVATE_COMMITS !== "true") return [];

  const repositories = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await github(
      `/user/repos?visibility=private&affiliation=owner&sort=pushed&per_page=100&page=${page}`,
    );
    repositories.push(...batch.filter((repo) => repo.owner?.login?.toLowerCase() === username.toLowerCase()));
    if (batch.length < 100) break;
  }
  return repositories;
}

async function getPrivateCommitCounts(repositories, days) {
  const counts = new Map(days.map((day) => [day, 0]));
  if (!process.env.PROFILE_GITHUB_TOKEN || repositories.length === 0) return counts;

  const since = `${days[0]}T00:00:00Z`;
  await mapWithConcurrency(repositories, 4, async (repo) => {
    for (let page = 1; page <= 10; page++) {
      const commits = await github(
        `/repos/${username}/${encodeURIComponent(repo.name)}/commits?author=${encodeURIComponent(username)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`,
      );
      for (const commit of commits) {
        const committedAt =
          commit.commit?.author?.date ?? commit.commit?.committer?.date;
        if (!committedAt) continue;
        const day = committedAt.slice(0, 10);
        if (counts.has(day)) counts.set(day, counts.get(day) + 1);
      }
      if (commits.length < 100) break;
    }
  });
  return counts;
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

function btcDashboardSvg(candle, article) {
  const formatPrice = (value) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  const titleLines = article
    ? (article.title.match(/.{1,52}(?:\s|$)/g) ?? [article.title])
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 2)
    : ["No recent Bitcoin news article found."];
  if (article && titleLines.join(" ").length < article.title.length) {
    titleLines[1] = `${titleLines[1].replace(/\.*$/, "")}...`;
  }
  const articleTitle = titleLines
    .map((line, index) => `<text x="500" y="${142 + index * 20}" class="news-title">${xml(line)}</text>`)
    .join("");
  const newsMeta = article
    ? `${article.source || "Google News"} · ${Number.isNaN(Date.parse(article.publishedAt)) ? "" : new Date(article.publishedAt).toISOString().replace("T", " ").slice(0, 16)} UTC`
    : "Google News RSS · BTC monitor news source";
  const articleLink = article
    ? `<a href="${xml(article.url)}">${articleTitle}</a>`
    : articleTitle;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="248" viewBox="0 0 960 248" role="img" aria-labelledby="title description">
  <title id="title">Bitcoin daily open, close, and latest news</title>
  <desc id="description">BTC/USD completed daily candle for ${xml(candle.date)}: open ${xml(formatPrice(candle.open))}, close ${xml(formatPrice(candle.close))}.${article ? ` Latest article: ${xml(article.title)}` : " No recent news article was found."}</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .heading { fill: #f0f6fc; font-size: 17px; font-weight: 700; }
    .muted { fill: #8b949e; font-size: 11px; }
    .label { fill: #8b949e; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
    .price { fill: #f0f6fc; font-size: 22px; font-weight: 700; }
    .news-title { fill: #58a6ff; font-size: 13px; font-weight: 600; }
    .coin-mark { fill: #fff; font-family: Arial, sans-serif; font-size: 27px; font-weight: 700; }
    a { text-decoration: none; }
  </style>
  <rect width="100%" height="100%" rx="12" fill="#0d1117"/>
  <text x="24" y="34" class="heading">BITCOIN // BTC/USD DAILY</text>
  <circle cx="57" cy="103" r="25" fill="#f7931a"/>
  <text x="57" y="112" class="coin-mark" text-anchor="middle">₿</text>
  <text x="96" y="94" class="label">LAST COMPLETED UTC CANDLE</text>
  <text x="96" y="116" class="muted">${xml(candle.date)} · Kraken BTC/USD daily candle</text>
  <a href="https://github.com/iiwiiInsider/Bitcoin_Price_And_News_Notifiyer">
    <text x="96" y="136" class="muted">BTC monitor: Bitcoin Price &amp; News Notifier ↗</text>
  </a>
  <text x="32" y="164" class="label">OPEN</text>
  <text x="32" y="194" class="price">${xml(formatPrice(candle.open))}</text>
  <text x="252" y="164" class="label">CLOSE</text>
  <text x="252" y="194" class="price">${xml(formatPrice(candle.close))}</text>
  <rect x="475" y="54" width="461" height="166" rx="10" fill="#161b22" stroke="#30363d"/>
  <text x="500" y="82" class="label">LATEST BITCOIN NEWS</text>
  ${articleLink}
  <text x="500" y="190" class="muted">${xml(newsMeta)}</text>
  <text x="500" y="207" class="muted">Feed used by the BTC monitor</text>
</svg>
`;
}

export function commitPulseSvg(events, privateCounts, privateActivityEnabled) {
  const days = recentUtcDays();
  const counts = new Map(
    days.map((day) => [
      day,
      privateActivityEnabled ? (privateCounts.get(day) ?? 0) : 0,
    ]),
  );

  for (const event of events) {
    if (event.type !== "PushEvent") continue;
    const day = event.created_at.slice(0, 10);
    if (counts.has(day)) {
      counts.set(day, counts.get(day) + Math.max(event.payload?.commits?.length ?? 0, 1));
    }
  }

  const values = days.map((day) => counts.get(day));
  const privateTotal = [...privateCounts.values()].reduce((sum, count) => sum + count, 0);
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
  <desc id="description">${total} commits in the last 30 days${privateActivityEnabled ? `, including ${privateTotal} from private repositories` : ", from public repositories only"}.</desc>
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
  <text x="24" y="32" class="title">COMMIT PULSE // ${total} COMMITS IN 30 DAYS</text>
  <text x="24" y="51" class="muted">${privateActivityEnabled ? `${privateTotal} PRIVATE + PUBLIC ACTIVITY · REPO DETAILS HIDDEN · UTC` : "PUBLIC ACTIVITY ONLY · ADD PROFILE_GITHUB_TOKEN TO INCLUDE PRIVATE COUNTS · UTC"}</text>
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
  for (let page = 1; page <= 10; page++) {
    const batch = await github(
      `/users/${username}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );
    repositories.push(...batch.filter((repo) => !repo.private));
    if (batch.length < 100) break;
  }

  const selected = repositories.slice(0, 25);
  const [activity, languageData, events, btcCandle, btcNews, privateRepositories] = await Promise.all([
    mapWithConcurrency(selected, 5, getLatestForRepository),
    mapWithConcurrency(repositories, 5, getRepositoryLanguages),
    getRecentPublicEvents(),
    getLatestBtcDailyCandle(),
    getLatestBitcoinNews(),
    getOwnedPrivateRepositories(),
  ]);
  const languageMix = aggregateLanguages(languageData);
  const days = recentUtcDays();
  const privateCounts = await getPrivateCommitCounts(privateRepositories, days);
  const privateActivityEnabled = process.env.INCLUDE_PRIVATE_COMMITS === "true";

  await mkdir("assets", { recursive: true });
  await Promise.all([
    writeFile("assets/repo-dashboard.svg", dashboardSvg(activity)),
    writeFile(
      "assets/commit-pulse.svg",
      commitPulseSvg(events, privateCounts, privateActivityEnabled),
    ),
    writeFile("assets/btc-dashboard.svg", btcDashboardSvg(btcCandle, btcNews)),
    writeFile(
      "assets/languages.svg",
      languageDashboardSvg(languageMix, repositories.length),
    ),
  ]);

  console.log(
    `Updated activity graphics for ${activity.length} repositories, all ${repositories.length} public repository language reports (${languageMix.length} languages), ${events.length} recent public events, ${privateRepositories.length} private repositories, and the BTC/USD candle for ${btcCandle.date}${btcNews ? " with a news article" : " without a news article"}.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
